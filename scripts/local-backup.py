#!/usr/bin/env python3
"""Small, same-host backup utility for the Nexus Hub SQLite database."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time
from typing import Iterator, NoReturn


SCHEMA = "nexus.local-backup.v1"
CONFIG_KEYS = {
    "NEXUS_LOCAL_BACKUP_DATABASE_PATH",
    "NEXUS_LOCAL_BACKUP_ROOT",
    "NEXUS_LOCAL_BACKUP_AGE_RECIPIENT",
    "NEXUS_LOCAL_BACKUP_AGE_IDENTITY",
}
BACKUP_PATTERN = re.compile(
    r"nexus-db-(?:[0-9]{8}T[0-9]{6}Z|[0-9]{8}|[0-9]{4}-W[0-9]{2})"
    r"\.sqlite\.age"
)


def fail(message: str) -> NoReturn:
    raise SystemExit(f"local backup: {message}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fsync_regular_file(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            fail(f"durability target is not a regular file: {path.name}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(path: Path) -> None:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(metadata.st_mode):
            fail(f"durability target is not a directory: {path.name}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_replace(temporary: Path, destination: Path) -> None:
    """Publish one file only after its bytes and namespace are durable."""
    fsync_regular_file(temporary)
    os.replace(temporary, destination)
    fsync_regular_file(destination)
    fsync_directory(destination.parent)


def write_json_atomic(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    fsync_directory(path.parent)
    fsync_directory(path.parent.parent)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("x", encoding="utf-8") as output:
        json.dump(value, output, indent=2, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    temporary.chmod(0o600)
    durable_replace(temporary, path)


def load_config(path: Path) -> dict[str, str]:
    if not path.is_absolute() or path == Path("/") or path.is_symlink():
        fail("config must be an absolute non-symlink file")
    if not path.is_file():
        fail("config does not exist")
    if os.environ.get("NEXUS_LOCAL_BACKUP_TEST_MODE") != "1":
        metadata = path.stat()
        if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
            fail("config must be root-owned mode 0600")

    result: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            fail(f"config line {line_number} is invalid")
        key, value = line.split("=", 1)
        if key not in CONFIG_KEYS or key in result or not value:
            fail(f"config line {line_number} is unsupported")
        result[key] = value
    missing = CONFIG_KEYS - result.keys()
    if missing:
        fail(f"config is missing {', '.join(sorted(missing))}")
    return result


def absolute_path(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path == Path("/"):
        fail(f"{label} must be an absolute non-root path")
    return path


def validate_config(config: dict[str, str], *, require_identity: bool) -> tuple[Path, Path, Path]:
    database = absolute_path(
        config["NEXUS_LOCAL_BACKUP_DATABASE_PATH"], "database path"
    )
    root = absolute_path(config["NEXUS_LOCAL_BACKUP_ROOT"], "backup root")
    identity = absolute_path(
        config["NEXUS_LOCAL_BACKUP_AGE_IDENTITY"], "age identity"
    )
    recipient = config["NEXUS_LOCAL_BACKUP_AGE_RECIPIENT"]
    if not recipient.startswith("age1") or any(character.isspace() for character in recipient):
        fail("age recipient is invalid")
    if require_identity:
        if identity.is_symlink() or not identity.is_file():
            fail("age identity is missing or unsafe")
        if os.environ.get("NEXUS_LOCAL_BACKUP_TEST_MODE") != "1":
            metadata = identity.stat()
            if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
                fail("age identity must be root-owned mode 0600")
    return database, root, identity


def integrity(path: Path) -> dict[str, object]:
    uri = f"{path.as_uri()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        integrity_row = connection.execute("PRAGMA integrity_check").fetchone()
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
    finally:
        connection.close()
    if integrity_row is None or integrity_row[0] != "ok":
        fail("SQLite integrity_check failed")
    if foreign_keys:
        fail("SQLite foreign_key_check failed")
    return {
        "plaintextSha256": sha256(path),
        "plaintextSizeBytes": path.stat().st_size,
        "integrityCheck": "ok",
        "foreignKeyCheck": "ok",
    }


def snapshot(source: Path, destination: Path) -> dict[str, object]:
    if source.is_symlink() or not source.is_file():
        fail("database is missing or unsafe")
    source_database = sqlite3.connect(
        f"{source.as_uri()}?mode=ro", uri=True, timeout=30
    )
    destination_database = sqlite3.connect(destination)
    try:
        source_database.backup(destination_database, pages=1024, sleep=0.025)
        destination_database.commit()
    finally:
        destination_database.close()
        source_database.close()
    destination.chmod(0o600)
    return integrity(destination)


@contextmanager
def backup_lock(root: Path) -> Iterator[None]:
    if root.is_symlink():
        fail("backup root must not be a symlink")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not root.is_dir():
        fail("backup root must be a directory")
    root.chmod(0o700)
    fsync_directory(root)
    fsync_directory(root.parent)
    lock_path = root / ".backup.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("another backup or restore verification is active")
        yield


def install_pair(source: Path, destination: Path, *, allow_existing: bool) -> None:
    if destination.exists() or destination.is_symlink():
        if not allow_existing or destination.is_symlink() or not destination.is_file():
            fail(f"backup target already exists or is unsafe: {destination.name}")
        checksum_path = destination.with_name(f"{destination.name}.sha256")
        if checksum_path.is_symlink() or not checksum_path.is_file():
            fail(f"existing backup checksum is missing or unsafe: {destination.name}")
        expected = checksum_path.read_text(encoding="utf-8").split()[0]
        if expected != sha256(destination):
            fail(f"existing backup checksum mismatch: {destination.name}")
        fsync_regular_file(destination)
        fsync_regular_file(checksum_path)
        fsync_directory(destination.parent)
        return
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    shutil.copyfile(source, temporary)
    temporary.chmod(0o600)
    durable_replace(temporary, destination)
    checksum_path = destination.with_name(f"{destination.name}.sha256")
    checksum_temporary = checksum_path.with_name(
        f".{checksum_path.name}.{os.getpid()}.tmp"
    )
    with checksum_temporary.open("x", encoding="utf-8") as output:
        output.write(f"{sha256(destination)}  {destination.name}\n")
        output.flush()
        os.fsync(output.fileno())
    checksum_temporary.chmod(0o600)
    durable_replace(checksum_temporary, checksum_path)


def prune(directory: Path, retain: int) -> None:
    backups = sorted(
        (
            entry
            for entry in directory.iterdir()
            if entry.is_file()
            and not entry.is_symlink()
            and BACKUP_PATTERN.fullmatch(entry.name)
        ),
        reverse=True,
    )
    for backup in backups[retain:]:
        backup.unlink()
        backup.with_name(f"{backup.name}.sha256").unlink(missing_ok=True)


def backup(config: dict[str, str], tier: str) -> dict[str, object]:
    database, root, _identity = validate_config(config, require_identity=False)
    # Record the producer invocation before attempting the backup lock or opening
    # the source database. A caller that reaches `systemctl start` while an older
    # oneshot is already activating must be able to distinguish that older
    # snapshot from work started for this exact request.
    started_at = datetime.now(timezone.utc)
    timestamp = started_at.strftime("%Y%m%dT%H%M%SZ")
    iso_year, iso_week, _ = started_at.isocalendar()
    names = {
        "hourly": f"nexus-db-{timestamp}.sqlite.age",
        "daily": f"nexus-db-{started_at:%Y%m%d}.sqlite.age",
        "weekly": f"nexus-db-{iso_year}-W{iso_week:02d}.sqlite.age",
        "pre-promotion": f"nexus-db-{timestamp}.sqlite.age",
    }
    retain = {"hourly": 24, "daily": 30, "weekly": 4, "pre-promotion": 10}

    with backup_lock(root):
        tier_directories: list[Path] = []
        for directory_name in retain:
            directory = root / directory_name
            directory.mkdir(mode=0o700, exist_ok=True)
            directory.chmod(0o700)
            fsync_directory(directory)
            tier_directories.append(directory)
        state = root / "state"
        state.mkdir(mode=0o700, exist_ok=True)
        state.chmod(0o700)
        fsync_directory(state)
        fsync_directory(root)

        with tempfile.TemporaryDirectory(prefix=".snapshot-", dir=root) as temporary_value:
            temporary = Path(temporary_value)
            temporary.chmod(0o700)
            plaintext = temporary / "database.sqlite"
            metadata = snapshot(database, plaintext)
            encrypted = temporary / "database.sqlite.age"
            age_binary = os.environ.get("NEXUS_LOCAL_BACKUP_AGE_BIN", "age")
            subprocess.run(
                [
                    age_binary,
                    "--encrypt",
                    "--recipient",
                    config["NEXUS_LOCAL_BACKUP_AGE_RECIPIENT"],
                    "--output",
                    str(encrypted),
                    str(plaintext),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            encrypted.chmod(0o600)
            if encrypted.stat().st_size <= 0:
                fail("age produced an empty backup")

            selected_tiers = (
                ["pre-promotion"] if tier == "pre-promotion" else ["hourly", "daily", "weekly"]
            )
            installed: dict[str, str] = {}
            for selected in selected_tiers:
                destination = root / selected / names[selected]
                install_pair(
                    encrypted,
                    destination,
                    allow_existing=selected in {"daily", "weekly"},
                )
                installed[selected] = str(destination)

        for selected, count in retain.items():
            prune(root / selected, count)
        for directory in tier_directories:
            fsync_directory(directory)

        completed_at = datetime.now(timezone.utc).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        receipt: dict[str, object] = {
            "schema": SCHEMA,
            "status": "passed",
            "kind": tier,
            "database": str(database),
            "backupRoot": str(root),
            "startedAt": started_at.isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            ),
            "completedAt": completed_at,
            "encryptedSha256": sha256(Path(next(iter(installed.values())))),
            "encryptedSizeBytes": Path(next(iter(installed.values()))).stat().st_size,
            "installed": installed,
            "retention": retain,
            **metadata,
        }
        write_json_atomic(state / "last-success.json", receipt)
        return receipt


def newest_backup(root: Path) -> Path:
    candidates = sorted((root / "hourly").glob("nexus-db-*.sqlite.age"), reverse=True)
    if not candidates:
        fail("no hourly backup exists")
    return candidates[0]


def decrypt_and_verify(
    config: dict[str, str], backup_path: Path | None, destination: Path | None
) -> dict[str, object]:
    _database, root, identity = validate_config(config, require_identity=True)
    with backup_lock(root):
        selected = backup_path or newest_backup(root)
        if selected.is_symlink() or not selected.is_file():
            fail("selected backup is missing or unsafe")
        selected = selected.resolve(strict=True)
        if root.resolve(strict=True) not in selected.parents:
            fail("selected backup is outside the configured root")
        expected_checksum = selected.with_name(f"{selected.name}.sha256")
        if not expected_checksum.is_file() or expected_checksum.is_symlink():
            fail("selected backup checksum is missing or unsafe")
        expected = expected_checksum.read_text(encoding="utf-8").split()[0]
        if expected != sha256(selected):
            fail("selected backup checksum mismatch")

        with tempfile.TemporaryDirectory(prefix=".restore-", dir=root) as temporary_value:
            temporary = Path(temporary_value)
            temporary.chmod(0o700)
            plaintext = temporary / "restored.sqlite"
            age_binary = os.environ.get("NEXUS_LOCAL_BACKUP_AGE_BIN", "age")
            subprocess.run(
                [
                    age_binary,
                    "--decrypt",
                    "--identity",
                    str(identity),
                    "--output",
                    str(plaintext),
                    str(selected),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            plaintext.chmod(0o600)
            metadata = integrity(plaintext)
            if destination is not None:
                if not destination.is_absolute() or destination == Path("/"):
                    fail("restore destination must be an absolute non-root path")
                if destination.exists() or destination.is_symlink():
                    fail("restore destination must be new")
                if destination.parent.resolve(strict=True) != destination.parent:
                    fail("restore destination parent must not traverse symlinks")
                shutil.copyfile(plaintext, destination)
                destination.chmod(0o600)

        result: dict[str, object] = {
            "schema": "nexus.local-backup-restore-verification.v1",
            "status": "passed",
            "backup": str(selected),
            "encryptedSha256": expected,
            "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            **metadata,
        }
        if destination is not None:
            result["destination"] = str(destination)
        write_json_atomic(root / "state" / "last-restore-verification.json", result)
        return result


def verify_freshness(config: dict[str, str], max_age_hours: int) -> dict[str, object]:
    _database, root, _identity = validate_config(config, require_identity=False)
    receipt_path = root / "state" / "last-success.json"
    if receipt_path.is_symlink() or not receipt_path.is_file():
        fail("last-success receipt is missing")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt.get("schema") != SCHEMA or receipt.get("status") != "passed":
        fail("last-success receipt is invalid")
    completed_at = datetime.fromisoformat(str(receipt["completedAt"]).replace("Z", "+00:00"))
    age_seconds = time.time() - completed_at.timestamp()
    if age_seconds < 0 or age_seconds > max_age_hours * 3600:
        fail("last successful backup is stale")
    installed = receipt.get("installed")
    if not isinstance(installed, dict) or not installed:
        fail("last-success receipt has no installed backup")
    selected_tier = (
        "pre-promotion" if receipt.get("kind") == "pre-promotion" else "hourly"
    )
    selected_value = installed.get(selected_tier)
    if not isinstance(selected_value, str) or not selected_value:
        fail(f"last-success receipt has no {selected_tier} backup")
    selected = Path(selected_value)
    if not selected.is_file() or sha256(selected) != receipt.get("encryptedSha256"):
        fail("last successful backup no longer matches its receipt")
    return {
        "schema": "nexus.local-backup-freshness.v1",
        "status": "passed",
        "completedAt": receipt["completedAt"],
        "ageSeconds": int(age_seconds),
        "maxAgeHours": max_age_hours,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("/etc/nexus-local-backup/backup.env"),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("verify-config")
    subparsers.add_parser("backup")
    subparsers.add_parser("pre-promotion")
    freshness_parser = subparsers.add_parser("verify-freshness")
    freshness_parser.add_argument("--max-age-hours", type=int, default=26)
    restore_parser = subparsers.add_parser("restore-verify")
    restore_parser.add_argument("--backup", type=Path)
    restore_parser.add_argument("--destination", type=Path)
    args = parser.parse_args()

    config = load_config(args.config)
    if args.command == "verify-config":
        database, root, identity = validate_config(config, require_identity=True)
        result: dict[str, object] = {
            "schema": "nexus.local-backup-config.v1",
            "status": "passed",
            "database": str(database),
            "backupRoot": str(root),
            "identity": str(identity),
        }
    elif args.command in {"backup", "pre-promotion"}:
        result = backup(config, args.command)
    elif args.command == "verify-freshness":
        if args.max_age_hours < 1 or args.max_age_hours > 168:
            fail("max age must be between 1 and 168 hours")
        result = verify_freshness(config, args.max_age_hours)
    else:
        result = decrypt_and_verify(config, args.backup, args.destination)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
