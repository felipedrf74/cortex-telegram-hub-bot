#!/usr/bin/env python3
"""Small, same-host backup utility for the Nexus Hub SQLite database."""

from __future__ import annotations

import argparse
from collections import namedtuple
from contextlib import ExitStack, contextmanager
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
import sys
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
BACKUP_LOCK_WAIT_SECONDS = 330.0
BACKUP_LOCK_RETRY_SECONDS = 0.1
LOCK_RETRY_SCHEMA = "nexus.local-backup-lock-retry.v1"
LOCK_RETRY_WINDOW_NS = 45 * 60 * 1_000_000_000
LOCK_RETRY_MAX_ATTEMPTS = 45
MAX_RETRY_CLOCK_NS = (2**63) - 1
LOCK_RETRY_STATE_PATHS = {
    "backup": Path("/run/nexus-local-backup-active/lock-retry.json"),
    "restore-verify": Path(
        "/run/nexus-local-backup-restore-verify-active/lock-retry.json"
    ),
}


FileIdentity = namedtuple("FileIdentity", ("device", "inode", "uid", "gid", "mode"))
BoundSource = namedtuple("BoundSource", ("descriptor", "identity"))


def fail(message: str) -> NoReturn:
    raise SystemExit(f"local backup: {message}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def expected_private_owner() -> tuple[int, int]:
    if os.environ.get("NEXUS_LOCAL_BACKUP_TEST_MODE") == "1":
        return os.getuid(), os.getgid()
    return 0, 0


def file_snapshot(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def directory_identity(metadata: os.stat_result) -> tuple[int, int]:
    return metadata.st_dev, metadata.st_ino


def assert_trusted_directory(
    metadata: os.stat_result, label: str, *, private: bool
) -> None:
    expected_uid, expected_gid = expected_private_owner()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_nlink < 1
        or (private and metadata.st_uid != expected_uid)
        or (private and metadata.st_gid != expected_gid)
        or (private and stat.S_IMODE(metadata.st_mode) != 0o700)
        or (not private and metadata.st_uid not in {0, expected_uid})
        or (not private and stat.S_IMODE(metadata.st_mode) & 0o022)
    ):
        fail(f"{label} has unsafe directory metadata")


@contextmanager
def bound_governed_directories(root: Path, tier: str | None = None) -> Iterator[None]:
    """Bind the private backup root/tier and its nearest trusted parent.

    Production walks from `/`; test mode may anchor at the fixture parent so
    macOS's `/var` compatibility symlink does not weaken production semantics.
    Every opened component remains bound until the caller completes.
    """
    target = root if tier is None else root / tier
    if not target.is_absolute() or target == Path("/"):
        fail("backup directory path is not governed")
    if os.environ.get("NEXUS_LOCAL_BACKUP_TEST_MODE") == "1":
        configured_anchor = os.environ.get("NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR")
        anchor = Path(configured_anchor) if configured_anchor else root.parent
    else:
        anchor = Path("/")
    try:
        relative = target.relative_to(anchor)
    except ValueError:
        fail("backup directory escapes its trusted anchor")
    paths = [anchor]
    current = anchor
    for component in relative.parts:
        current /= component
        paths.append(current)
    bindings: list[tuple[Path, int, os.stat_result, bool]] = []
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        for candidate in paths:
            descriptor = os.open(candidate, flags)
            bindings.append((candidate, descriptor, os.fstat(descriptor), candidate in {root, target}))
            named = candidate.lstat()
            opened = bindings[-1][2]
            private = candidate in {root, target}
            assert_trusted_directory(opened, "backup directory", private=private)
            assert_trusted_directory(named, "backup directory", private=private)
            if directory_identity(opened) != directory_identity(named):
                fail("backup directory descriptor and path disagree")
        yield
        for candidate, descriptor, opened, private in bindings:
            current_descriptor = os.fstat(descriptor)
            current_path = candidate.lstat()
            assert_trusted_directory(current_descriptor, "backup directory", private=private)
            assert_trusted_directory(current_path, "backup directory", private=private)
            if (
                directory_identity(current_descriptor) != directory_identity(opened)
                or directory_identity(current_path) != directory_identity(opened)
            ):
                fail("backup directory changed during verification")
    except OSError as error:
        fail(f"backup directory could not be descriptor-bound: {type(error).__name__}")
    finally:
        for _candidate, descriptor, _opened, _private in reversed(bindings):
            os.close(descriptor)


def assert_private_regular(
    metadata: os.stat_result, label: str, *, empty: bool = False
) -> None:
    expected_uid, expected_gid = expected_private_owner()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != expected_uid
        or metadata.st_gid != expected_gid
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or (empty and metadata.st_size != 0)
        or (not empty and metadata.st_size <= 0)
    ):
        fail(f"{label} has unsafe metadata")


def reassert_bound_file(
    path: Path, descriptor: int, opened: os.stat_result, label: str, *, empty: bool = False
) -> None:
    current_descriptor = os.fstat(descriptor)
    current_path = path.lstat()
    assert_private_regular(current_descriptor, label, empty=empty)
    assert_private_regular(current_path, label, empty=empty)
    if (
        file_snapshot(current_descriptor) != file_snapshot(opened)
        or file_snapshot(current_path) != file_snapshot(opened)
    ):
        fail(f"{label} changed during verification")


@contextmanager
def bound_private_file(path: Path, label: str, *, empty: bool = False) -> Iterator[tuple[int, os.stat_result]]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        named = path.lstat()
        assert_private_regular(opened, label, empty=empty)
        assert_private_regular(named, label, empty=empty)
        if file_snapshot(opened) != file_snapshot(named):
            fail(f"{label} descriptor and path disagree")
        yield descriptor, opened
        reassert_bound_file(path, descriptor, opened, label, empty=empty)
    except (OSError, UnicodeError) as error:
        fail(f"{label} could not be descriptor-bound: {type(error).__name__}")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def sha256_descriptor(descriptor: int, size: int) -> str:
    digest = hashlib.sha256()
    position = 0
    while position < size:
        block = os.pread(descriptor, min(1024 * 1024, size - position), position)
        if not block:
            fail("encrypted backup ended during hashing")
        digest.update(block)
        position += len(block)
    return digest.hexdigest()


@contextmanager
def bound_backup_pair(
    root: Path,
    artifact: Path,
    *,
    expected_tier: str | None = None,
    expected_digest: str | None = None,
    expected_size: int | None = None,
) -> Iterator[tuple[int, str, int]]:
    tiers = {"hourly", "daily", "weekly", "pre-promotion"}
    tier = artifact.parent.name
    if expected_tier is not None and tier != expected_tier:
        fail("selected backup is outside its governed tier")
    if tier not in tiers or artifact.parent != root / tier or not BACKUP_PATTERN.fullmatch(artifact.name):
        fail("selected backup path is not governed")
    checksum = artifact.with_name(f"{artifact.name}.sha256")
    with ExitStack() as stack:
        stack.enter_context(bound_governed_directories(root, tier))
        artifact_descriptor, artifact_metadata = stack.enter_context(
            bound_private_file(artifact, "encrypted backup")
        )
        checksum_descriptor, _checksum_metadata = stack.enter_context(
            bound_private_file(checksum, "encrypted backup checksum")
        )
        observed_digest = sha256_descriptor(artifact_descriptor, artifact_metadata.st_size)
        canonical = f"{observed_digest}  {artifact.name}\n".encode("ascii")
        checksum_bytes = os.pread(checksum_descriptor, len(canonical) + 1, 0)
        if checksum_bytes != canonical:
            fail("encrypted backup checksum is not canonical")
        if expected_digest is not None and observed_digest != expected_digest:
            fail("encrypted backup digest does not match its receipt")
        if expected_size is not None and artifact_metadata.st_size != expected_size:
            fail("encrypted backup size does not match its receipt")
        yield artifact_descriptor, observed_digest, artifact_metadata.st_size


def validate_backup_pair(
    root: Path,
    artifact: Path,
    *,
    expected_tier: str | None = None,
    expected_digest: str | None = None,
    expected_size: int | None = None,
) -> tuple[str, int]:
    with bound_backup_pair(
        root,
        artifact,
        expected_tier=expected_tier,
        expected_digest=expected_digest,
        expected_size=expected_size,
    ) as (_descriptor, digest, size):
        return digest, size


def copy_bound_descriptor(descriptor: int, size: int, destination: Path) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    output = os.open(destination, flags, 0o600)
    try:
        position = 0
        while position < size:
            block = os.pread(descriptor, min(1024 * 1024, size - position), position)
            if not block:
                fail("bound recovery input ended during copy")
            written = os.write(output, block)
            if written != len(block):
                fail("bound recovery input copy was incomplete")
            position += written
        os.fsync(output)
    finally:
        os.close(output)


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


def lock_retry_state_path(source: str) -> Path | None:
    if source not in LOCK_RETRY_STATE_PATHS:
        return None
    if os.environ.get("NEXUS_LOCAL_BACKUP_TEST_MODE") == "1":
        test_directory = os.environ.get("NEXUS_LOCAL_BACKUP_TEST_RETRY_DIRECTORY")
        return Path(test_directory) / f"{source}.json" if test_directory else None
    return LOCK_RETRY_STATE_PATHS[source]


def retry_clock_ns() -> int:
    if os.environ.get("NEXUS_LOCAL_BACKUP_TEST_MODE") == "1":
        observed = time.time_ns()
    else:
        clock_id = getattr(time, "CLOCK_BOOTTIME", None)
        clock_gettime_ns = getattr(time, "clock_gettime_ns", None)
        if clock_id is None or not callable(clock_gettime_ns):
            fail("boot-time retry clock is unavailable")
        try:
            observed = clock_gettime_ns(clock_id)
        except (OSError, ValueError):
            fail("boot-time retry clock could not be read")
    if (
        isinstance(observed, bool)
        or not isinstance(observed, int)
        or observed < 0
        or observed > MAX_RETRY_CLOCK_NS
    ):
        fail("boot-time retry clock is invalid")
    return observed


@contextmanager
def bound_retry_directory(directory: Path) -> Iterator[int]:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor: int | None = None
    try:
        descriptor = os.open(directory, flags)
        opened = os.fstat(descriptor)
        named = directory.lstat()
        assert_trusted_directory(opened, "lock retry directory", private=True)
        assert_trusted_directory(named, "lock retry directory", private=True)
        if directory_identity(opened) != directory_identity(named):
            fail("lock retry directory descriptor and path disagree")
        yield descriptor
        current_descriptor = os.fstat(descriptor)
        current_path = directory.lstat()
        assert_trusted_directory(current_descriptor, "lock retry directory", private=True)
        assert_trusted_directory(current_path, "lock retry directory", private=True)
        if (
            directory_identity(current_descriptor) != directory_identity(opened)
            or directory_identity(current_path) != directory_identity(opened)
        ):
            fail("lock retry directory changed")
    except OSError as error:
        fail(f"lock retry directory could not be descriptor-bound: {type(error).__name__}")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def read_retry_state(path: Path, source: str, now_ns: int) -> dict[str, object] | None:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        try:
            descriptor = os.open(path, flags)
        except FileNotFoundError:
            return None
        metadata = os.fstat(descriptor)
        named = path.lstat()
        assert_private_regular(metadata, "lock retry state")
        assert_private_regular(named, "lock retry state")
        if file_snapshot(metadata) != file_snapshot(named):
            fail("lock retry state descriptor and path disagree")
        if metadata.st_size > 1024:
            fail("lock retry state is oversized")
        raw = os.pread(descriptor, metadata.st_size + 1, 0)
        if len(raw) != metadata.st_size:
            fail("lock retry state changed during read")
        reassert_bound_file(path, descriptor, metadata, "lock retry state")
        try:
            state = json.loads(raw.decode("utf-8", errors="strict"))
        except (UnicodeError, json.JSONDecodeError):
            fail("lock retry state is invalid")
    except OSError as error:
        fail(f"lock retry state could not be descriptor-bound: {type(error).__name__}")
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if not isinstance(state, dict) or set(state) != {
        "schema", "source", "startedBoottimeNs", "attempts"
    }:
        fail("lock retry state fields are invalid")
    started = state.get("startedBoottimeNs")
    attempts = state.get("attempts")
    if (
        state.get("schema") != LOCK_RETRY_SCHEMA
        or state.get("source") != source
        or isinstance(started, bool)
        or not isinstance(started, int)
        or started < 0
        or started > MAX_RETRY_CLOCK_NS
        or started > now_ns
        or isinstance(attempts, bool)
        or not isinstance(attempts, int)
        or attempts < 1
        or attempts > LOCK_RETRY_MAX_ATTEMPTS
    ):
        fail("lock retry state values are invalid")
    return state


def write_retry_state(path: Path, state: dict[str, object]) -> None:
    payload = (json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
    flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    created = False
    try:
        try:
            descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
            created = True
        except FileExistsError:
            descriptor = os.open(path, flags)
            opened = os.fstat(descriptor)
            named = path.lstat()
            assert_private_regular(opened, "lock retry state")
            assert_private_regular(named, "lock retry state")
            if file_snapshot(opened) != file_snapshot(named):
                fail("lock retry state descriptor and path disagree")
        os.ftruncate(descriptor, 0)
        if os.write(descriptor, payload) != len(payload):
            fail("lock retry state write was incomplete")
        os.fsync(descriptor)
        current_descriptor = os.fstat(descriptor)
        current_path = path.lstat()
        assert_private_regular(current_descriptor, "lock retry state")
        assert_private_regular(current_path, "lock retry state")
        if file_snapshot(current_descriptor) != file_snapshot(current_path):
            fail("lock retry state descriptor and path disagree")
        if created:
            fsync_directory(path.parent)
    except OSError as error:
        fail(f"lock retry state could not be written: {type(error).__name__}")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def clear_retry_state(path: Path | None) -> None:
    if path is None:
        return
    try:
        parent_metadata = path.parent.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(parent_metadata.st_mode) or path.parent.is_symlink():
        fail("lock retry directory is unsafe")
    with bound_retry_directory(path.parent):
        descriptor: int | None = None
        try:
            flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
            try:
                descriptor = os.open(path, flags)
            except FileNotFoundError:
                return
            opened = os.fstat(descriptor)
            named = path.lstat()
            assert_private_regular(opened, "lock retry state")
            assert_private_regular(named, "lock retry state")
            if file_snapshot(opened) != file_snapshot(named):
                fail("lock retry state descriptor and path disagree")
            os.unlink(path)
            fsync_directory(path.parent)
            if path.exists() or path.is_symlink():
                fail("lock retry state removal was not durable")
        except OSError as error:
            fail(f"lock retry state could not be cleared: {type(error).__name__}")
        finally:
            if descriptor is not None:
                os.close(descriptor)


def begin_lock_retry(path: Path | None, source: str) -> bool:
    if path is None:
        return False
    now_ns = retry_clock_ns()
    with bound_retry_directory(path.parent):
        state = read_retry_state(path, source, now_ns)
        if state is None:
            started = now_ns
            attempts = 1
        else:
            started = int(state["startedBoottimeNs"])
            attempts = int(state["attempts"]) + 1
        if (
            now_ns - started >= LOCK_RETRY_WINDOW_NS
            or attempts > LOCK_RETRY_MAX_ATTEMPTS
        ):
            clear_retry_state(path)
            return False
        write_retry_state(path, {
            "schema": LOCK_RETRY_SCHEMA,
            "source": source,
            "startedBoottimeNs": started,
            "attempts": attempts,
        })
        return True


def retry_state_allows_attempt(path: Path | None, source: str) -> bool:
    if path is None:
        return True
    try:
        parent_metadata = path.parent.lstat()
    except FileNotFoundError:
        return True
    if not stat.S_ISDIR(parent_metadata.st_mode) or path.parent.is_symlink():
        fail("lock retry directory is unsafe")
    now_ns = retry_clock_ns()
    with bound_retry_directory(path.parent):
        state = read_retry_state(path, source, now_ns)
        if state is None:
            return True
        started = int(state["startedBoottimeNs"])
        attempts = int(state["attempts"])
        if (
            now_ns - started >= LOCK_RETRY_WINDOW_NS
            or attempts >= LOCK_RETRY_MAX_ATTEMPTS
        ):
            clear_retry_state(path)
            return False
        return True


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


def file_identity(metadata: os.stat_result) -> FileIdentity:
    return FileIdentity(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        uid=metadata.st_uid,
        gid=metadata.st_gid,
        mode=stat.S_IMODE(metadata.st_mode),
    )


def require_bound_path(path: Path, identity: FileIdentity, label: str) -> None:
    try:
        metadata = os.stat(path, follow_symlinks=False)
    except OSError:
        fail(f"{label} identity changed")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or file_identity(metadata) != identity
    ):
        fail(f"{label} identity changed")


def bind_source_database(source: Path) -> BoundSource:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(source, flags)
    except OSError:
        fail("database is missing or unsafe")
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            fail("database must be a single-link regular file")
        identity = file_identity(metadata)
        require_bound_path(source, identity, "database")
        return BoundSource(descriptor=descriptor, identity=identity)
    except BaseException:
        os.close(descriptor)
        raise


def process_descriptor_numbers() -> set[int]:
    directories = (
        (Path("/proc/self/fd"),)
        if sys.platform.startswith("linux")
        else (Path("/proc/self/fd"), Path("/dev/fd"))
    )
    for directory in directories:
        try:
            candidates = {
                int(entry)
                for entry in os.listdir(directory)
                if entry.isdecimal()
            }
        except OSError:
            continue
        # Directory enumeration can report its own already-closed descriptor.
        # Retain only descriptors still bound in this process after the scan.
        result: set[int] = set()
        for descriptor in candidates:
            try:
                os.fstat(descriptor)
            except OSError:
                continue
            result.add(descriptor)
        return result
    fail("cannot inspect process file descriptors")


def require_sqlite_source_descriptors(
    source: Path,
    source_binding: BoundSource,
    previous_descriptors: set[int],
    journal_mode: str,
) -> None:
    required = {"database": source_binding.identity}
    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{source}{suffix}")
        inspected = inspect_sqlite_sidecar(sidecar)
        if inspected is None:
            if journal_mode == "wal":
                fail(f"SQLite WAL mode is missing bound database{suffix}")
            continue
        descriptor, identity = inspected
        try:
            required[f"database{suffix}"] = identity
        finally:
            os.close(descriptor)

    new_descriptors = process_descriptor_numbers() - previous_descriptors
    observed: set[FileIdentity] = set()
    for descriptor in new_descriptors:
        try:
            metadata = os.fstat(descriptor)
        except OSError:
            continue
        if not stat.S_ISREG(metadata.st_mode):
            continue
        if metadata.st_nlink != 1:
            fail("SQLite descriptor set contains an unsafe regular file")
        observed.add(file_identity(metadata))
    missing = [label for label, identity in required.items() if identity not in observed]
    if missing:
        fail(f"SQLite descriptor set is missing bound {', '.join(missing)}")
    expected = set(required.values())
    unexpected = observed - expected
    if unexpected:
        fail("SQLite descriptor set contains an unbound regular file")


def inspect_sqlite_sidecar(path: Path) -> tuple[int, FileIdentity] | None:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError:
        fail(f"SQLite sidecar is missing or unsafe: {path.name}")
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            fail(f"SQLite sidecar must be a single-link regular file: {path.name}")
        identity = file_identity(metadata)
        require_bound_path(path, identity, f"SQLite sidecar {path.name}")
        return descriptor, identity
    except BaseException:
        os.close(descriptor)
        raise


def prevalidate_sqlite_sidecars(
    source: Path, source_identity: FileIdentity
) -> dict[str, FileIdentity | None]:
    result: dict[str, FileIdentity | None] = {}
    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{source}{suffix}")
        inspected = inspect_sqlite_sidecar(sidecar)
        if inspected is None:
            result[suffix] = None
            continue
        descriptor, identity = inspected
        try:
            if (
                identity.uid != source_identity.uid
                or identity.gid != source_identity.gid
                or identity.mode != source_identity.mode
            ):
                fail(f"SQLite sidecar has unsafe ownership or mode: {sidecar.name}")
            result[suffix] = identity
        finally:
            os.close(descriptor)
    return result


def normalize_sqlite_sidecars(
    source: Path,
    source_binding: BoundSource,
    previous: dict[str, FileIdentity | None],
) -> None:
    source_identity = source_binding.identity
    require_bound_path(source, source_identity, "database")
    if file_identity(os.fstat(source_binding.descriptor)) != source_identity:
        fail("database descriptor metadata changed")

    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{source}{suffix}")
        inspected = inspect_sqlite_sidecar(sidecar)
        before = previous[suffix]
        if inspected is None:
            if before is not None:
                fail(f"SQLite sidecar identity changed: {sidecar.name}")
            continue

        descriptor, current = inspected
        try:
            same_identity = (
                before is not None
                and current.device == before.device
                and current.inode == before.inode
            )
            if same_identity:
                if current != before or (
                    current.uid != source_identity.uid
                    or current.gid != source_identity.gid
                    or current.mode != source_identity.mode
                ):
                    fail(f"SQLite sidecar metadata changed: {sidecar.name}")
                continue

            source_owned = (
                current.uid == source_identity.uid
                and current.gid == source_identity.gid
                and current.mode == source_identity.mode
            )
            if source_owned:
                # A concurrent source owner may have created or replaced this
                # sidecar. Its exact metadata is already safe; do not mutate it.
                continue
            if current.uid != 0 or os.geteuid() != 0:
                fail(f"SQLite sidecar has unsafe owner: {sidecar.name}")

            # The sidecar was absent or had a different identity before the
            # privileged read-only open, and is owned by this process. Repair it
            # through the already-bound descriptor; never unlink a pathname.
            if (
                current.uid != source_identity.uid
                or current.gid != source_identity.gid
            ):
                os.fchown(descriptor, source_identity.uid, source_identity.gid)
            os.fchmod(descriptor, source_identity.mode)
            os.fsync(descriptor)
            fsync_directory(source.parent)
            normalized = file_identity(os.fstat(descriptor))
            if normalized.device != current.device or normalized.inode != current.inode:
                fail(f"SQLite sidecar identity changed: {sidecar.name}")
            if (
                normalized.uid != source_identity.uid
                or normalized.gid != source_identity.gid
                or normalized.mode != source_identity.mode
            ):
                fail(f"SQLite sidecar normalization failed: {sidecar.name}")
            require_bound_path(sidecar, normalized, f"SQLite sidecar {sidecar.name}")
            rebound = inspect_sqlite_sidecar(sidecar)
            if rebound is None:
                fail(f"SQLite sidecar identity changed: {sidecar.name}")
            rebound_descriptor, rebound_identity = rebound
            try:
                if rebound_identity != normalized:
                    fail(f"SQLite sidecar identity changed: {sidecar.name}")
            finally:
                os.close(rebound_descriptor)
        finally:
            os.close(descriptor)


def snapshot(source: Path, destination: Path) -> dict[str, object]:
    source_binding = bind_source_database(source)
    sidecars: dict[str, FileIdentity | None] = {}
    source_database: sqlite3.Connection | None = None
    destination_database: sqlite3.Connection | None = None
    connection_attempted = False
    try:
        sidecars = prevalidate_sqlite_sidecars(source, source_binding.identity)
        try:
            require_bound_path(source, source_binding.identity, "database")
            previous_descriptors = process_descriptor_numbers()
            connection_attempted = True
            source_database = sqlite3.connect(
                f"{source.as_uri()}?mode=ro", uri=True, timeout=30
            )
            # Force SQLite to initialize the WAL/SHM view before any copy work.
            source_database.execute("PRAGMA schema_version").fetchone()
            journal_mode_row = source_database.execute("PRAGMA journal_mode").fetchone()
            if journal_mode_row is None:
                fail("SQLite journal mode is unavailable")
            journal_mode = str(journal_mode_row[0]).lower()
            # Repair sidecars immediately, so privileged ownership does not
            # persist for the duration of a potentially long snapshot.
            normalize_sqlite_sidecars(source, source_binding, sidecars)
            require_sqlite_source_descriptors(
                source, source_binding, previous_descriptors, journal_mode
            )
            require_bound_path(source, source_binding.identity, "database")
            destination_database = sqlite3.connect(destination)
            # Finite page batches reopen the source read transaction between steps.
            # A read-only WAL/SHM view can then restart every batch from page one.
            source_database.backup(destination_database, pages=-1)
            destination_database.commit()
        finally:
            try:
                if destination_database is not None:
                    destination_database.close()
            finally:
                if source_database is not None:
                    source_database.close()
    finally:
        try:
            if connection_attempted:
                normalize_sqlite_sidecars(source, source_binding, sidecars)
        finally:
            os.close(source_binding.descriptor)
    destination.chmod(0o600)
    return integrity(destination)


@contextmanager
def backup_lock(root: Path, *, retry_source: str | None = None) -> Iterator[None]:
    with ExitStack() as stack:
        stack.enter_context(bound_governed_directories(root.parent))
        try:
            root.mkdir(mode=0o700)
            fsync_directory(root.parent)
        except FileExistsError:
            pass
        stack.enter_context(bound_governed_directories(root))
        fsync_directory(root)
        lock_path = root / ".backup.lock"
        flags = (
            os.O_RDWR
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        lock_descriptor: int | None = None
        created = False
        try:
            try:
                lock_descriptor = os.open(
                    lock_path, flags | os.O_CREAT | os.O_EXCL, 0o600
                )
                created = True
            except FileExistsError:
                lock_descriptor = os.open(lock_path, flags)
            opened_lock = os.fstat(lock_descriptor)
            named_lock = lock_path.lstat()
            assert_private_regular(opened_lock, "backup lock", empty=True)
            assert_private_regular(named_lock, "backup lock", empty=True)
            if file_snapshot(opened_lock) != file_snapshot(named_lock):
                fail("backup lock descriptor and path disagree")
            if created:
                os.fsync(lock_descriptor)
                fsync_directory(root)
            retry_path = lock_retry_state_path(retry_source) if retry_source else None
            if retry_source and not retry_state_allows_attempt(retry_path, retry_source):
                fail("backup lock retry deadline or attempt limit was exhausted")
            deadline = time.monotonic() + BACKUP_LOCK_WAIT_SECONDS
            while True:
                try:
                    fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if retry_source:
                        if begin_lock_retry(retry_path, retry_source):
                            raise SystemExit(75)
                        fail("backup lock retry deadline or attempt limit was exhausted")
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        fail("another backup or restore verification remained active")
                    time.sleep(min(BACKUP_LOCK_RETRY_SECONDS, remaining))
            reassert_bound_file(lock_path, lock_descriptor, opened_lock, "backup lock", empty=True)
            if retry_source:
                clear_retry_state(lock_retry_state_path(retry_source))
            yield
            reassert_bound_file(lock_path, lock_descriptor, opened_lock, "backup lock", empty=True)
        except OSError as error:
            fail(f"backup lock could not be descriptor-bound: {type(error).__name__}")
        finally:
            if lock_descriptor is not None:
                os.close(lock_descriptor)


def install_pair(source: Path, destination: Path, *, allow_existing: bool) -> None:
    if destination.exists() or destination.is_symlink():
        if not allow_existing or destination.is_symlink() or not destination.is_file():
            fail(f"backup target already exists or is unsafe: {destination.name}")
        checksum_path = destination.with_name(f"{destination.name}.sha256")
        validate_backup_pair(
            destination.parent.parent,
            destination,
            expected_tier=destination.parent.name,
        )
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
    validate_backup_pair(
        destination.parent.parent,
        destination,
        expected_tier=destination.parent.name,
    )


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

    with backup_lock(root, retry_source="backup" if tier == "backup" else None):
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
        receipt_artifact = Path(next(iter(installed.values())))
        receipt_digest, receipt_size = validate_backup_pair(
            root,
            receipt_artifact,
            expected_tier=receipt_artifact.parent.name,
        )
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
            "encryptedSha256": receipt_digest,
            "encryptedSizeBytes": receipt_size,
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
    with backup_lock(root, retry_source="restore-verify"):
        selected = backup_path or newest_backup(root)
        expected_tier = "hourly" if backup_path is None else selected.parent.name
        with tempfile.TemporaryDirectory(prefix=".restore-", dir=root) as temporary_value:
            temporary = Path(temporary_value)
            temporary.chmod(0o700)
            encrypted_copy = temporary / "selected.sqlite.age"
            with bound_backup_pair(
                root,
                selected,
                expected_tier=expected_tier,
            ) as (selected_descriptor, expected, encrypted_size):
                copy_bound_descriptor(selected_descriptor, encrypted_size, encrypted_copy)
            if sha256(encrypted_copy) != expected:
                fail("private encrypted backup copy changed")
            identity_copy = temporary / "age-identity.txt"
            with bound_private_file(identity, "age identity") as (
                identity_descriptor,
                identity_metadata,
            ):
                copy_bound_descriptor(
                    identity_descriptor,
                    identity_metadata.st_size,
                    identity_copy,
                )
            plaintext = temporary / "restored.sqlite"
            age_binary = os.environ.get("NEXUS_LOCAL_BACKUP_AGE_BIN", "age")
            subprocess.run(
                [
                    age_binary,
                    "--decrypt",
                    "--identity",
                    str(identity_copy),
                    "--output",
                    str(plaintext),
                    str(encrypted_copy),
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
            "verifiedAt": datetime.now(timezone.utc).isoformat(
                timespec="milliseconds"
            ).replace("+00:00", "Z"),
            **metadata,
        }
        if destination is not None:
            result["destination"] = str(destination)
        write_json_atomic(root / "state" / "last-restore-verification.json", result)
        return result


def verify_freshness_locked(config: dict[str, str], max_age_hours: int) -> dict[str, object]:
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
    validate_backup_pair(
        root,
        selected,
        expected_tier=selected_tier,
        expected_digest=receipt.get("encryptedSha256"),
        expected_size=receipt.get("encryptedSizeBytes"),
    )
    return {
        "schema": "nexus.local-backup-freshness.v1",
        "status": "passed",
        "completedAt": receipt["completedAt"],
        "ageSeconds": int(age_seconds),
        "maxAgeHours": max_age_hours,
    }


def verify_freshness(config: dict[str, str], max_age_hours: int) -> dict[str, object]:
    _database, root, _identity = validate_config(config, require_identity=False)
    with backup_lock(root):
        return verify_freshness_locked(config, max_age_hours)


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
