#!/usr/bin/python3
"""Run fixed release recovery checks while holding descriptor-bound kernel locks."""

from __future__ import annotations

from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
from typing import Iterator


BACKUP_LOCK = Path("/srv/nexus-backups/application/.backup.lock")
ALERT_LOCK = Path("/var/lib/nexus-release/operational-alerts/alert.lock")
HEARTBEAT = "/opt/nexus-release/checkout/scripts/release-heartbeat.mjs"
OPERATIONAL_ALERT = "/opt/nexus-release/checkout/scripts/release-operational-alert.mjs"
PRODUCER_MARKERS = (
    Path("/run/nexus-local-backup-active"),
    Path("/run/nexus-local-backup-restore-verify-active"),
    Path("/run/nexus-local-backup-pre-promotion-active"),
)
WEEKLY_PRODUCER_DEADLINE_SECONDS = 5400.0
ALERT_LOCK_WAIT_SECONDS = 120.0
LOCK_CREATE_RETRY_SECONDS = 5.0
POLL_SECONDS = 0.1
VERDICTS = {
    "healthy",
    "backup_policy_invalid",
    "backup_evidence_invalid",
    "backup_receipt_stale",
    "restore_verification_stale",
}
OPERATION_UNITS = {
    "nexus-local-backup.service",
    "nexus-local-backup-restore-verify.service",
}


def fail() -> None:
    raise SystemExit(70)


def snapshot(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def validate_lock_metadata(
    metadata: os.stat_result, *, expected_uid: int = 0, expected_gid: int = 0
) -> None:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != expected_uid
        or metadata.st_gid != expected_gid
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_size != 0
    ):
        fail()


def validate_parent_metadata(
    metadata: os.stat_result,
    *,
    final: bool,
    expected_uid: int,
    expected_gid: int,
) -> None:
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_nlink < 1:
        fail()
    mode = stat.S_IMODE(metadata.st_mode)
    if final:
        if metadata.st_uid != expected_uid or metadata.st_gid != expected_gid or mode != 0o700:
            fail()
    elif metadata.st_uid not in {0, expected_uid} or mode & 0o022:
        fail()


@contextmanager
def bound_parent_chain(
    directory: Path,
    *,
    expected_uid: int = 0,
    expected_gid: int = 0,
) -> Iterator[None]:
    if not directory.is_absolute() or directory == Path("/"):
        fail()
    paths = [Path("/")]
    current = Path("/")
    for component in directory.parts[1:]:
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
        for index, candidate in enumerate(paths):
            descriptor = os.open(candidate, flags)
            opened = os.fstat(descriptor)
            named = candidate.lstat()
            final = index == len(paths) - 1
            validate_parent_metadata(
                opened,
                final=final,
                expected_uid=expected_uid,
                expected_gid=expected_gid,
            )
            validate_parent_metadata(
                named,
                final=final,
                expected_uid=expected_uid,
                expected_gid=expected_gid,
            )
            if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
                fail()
            bindings.append((candidate, descriptor, opened, final))
        yield
        for candidate, descriptor, opened, final in bindings:
            current_descriptor = os.fstat(descriptor)
            current_path = candidate.lstat()
            validate_parent_metadata(
                current_descriptor,
                final=final,
                expected_uid=expected_uid,
                expected_gid=expected_gid,
            )
            validate_parent_metadata(
                current_path,
                final=final,
                expected_uid=expected_uid,
                expected_gid=expected_gid,
            )
            identity = (opened.st_dev, opened.st_ino)
            if ((current_descriptor.st_dev, current_descriptor.st_ino) != identity
                    or (current_path.st_dev, current_path.st_ino) != identity):
                fail()
    except OSError:
        fail()
    finally:
        for _candidate, descriptor, _opened, _final in reversed(bindings):
            os.close(descriptor)


def reassert_lock(
    path: Path,
    descriptor: int,
    opened: os.stat_result,
    *,
    expected_uid: int = 0,
    expected_gid: int = 0,
) -> None:
    current_descriptor = os.fstat(descriptor)
    current_path = path.lstat()
    validate_lock_metadata(
        current_descriptor, expected_uid=expected_uid, expected_gid=expected_gid
    )
    validate_lock_metadata(current_path, expected_uid=expected_uid, expected_gid=expected_gid)
    if snapshot(current_descriptor) != snapshot(opened) or snapshot(current_path) != snapshot(opened):
        fail()


@contextmanager
def bound_lock(
    path: Path,
    *,
    create: bool,
    expected_uid: int = 0,
    expected_gid: int = 0,
) -> Iterator[int]:
    with bound_parent_chain(
        path.parent,
        expected_uid=expected_uid,
        expected_gid=expected_gid,
    ):
        access = os.O_RDWR if create else os.O_RDONLY
        flags = access | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor: int | None = None
        created = False
        try:
            create_deadline = time.monotonic() + LOCK_CREATE_RETRY_SECONDS
            while descriptor is None:
                try:
                    descriptor = os.open(path, flags)
                except FileNotFoundError:
                    if not create:
                        raise
                    try:
                        descriptor = os.open(
                            path, flags | os.O_CREAT | os.O_EXCL, 0o600
                        )
                        created = True
                    except FileExistsError:
                        # Another alert writer won first creation between the
                        # absent-path observation and O_EXCL. Reopen its exact
                        # governed inode instead of dropping this incident.
                        remaining = create_deadline - time.monotonic()
                        if remaining <= 0:
                            raise
                        time.sleep(min(POLL_SECONDS, remaining))
            opened = os.fstat(descriptor)
            named = path.lstat()
            validate_lock_metadata(opened, expected_uid=expected_uid, expected_gid=expected_gid)
            validate_lock_metadata(named, expected_uid=expected_uid, expected_gid=expected_gid)
            if snapshot(opened) != snapshot(named):
                fail()
            if created:
                os.fsync(descriptor)
                directory_flags = (
                    os.O_RDONLY
                    | getattr(os, "O_CLOEXEC", 0)
                    | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0)
                )
                # StateDirectory may itself be new on the first incident. Sync
                # the lock entry and both containing namespace entries before
                # delivery attempt one can leave the host.
                for directory in (path.parent, path.parent.parent):
                    directory_descriptor = os.open(directory, directory_flags)
                    try:
                        os.fsync(directory_descriptor)
                    finally:
                        os.close(directory_descriptor)
            yield descriptor
            reassert_lock(
                path,
                descriptor,
                opened,
                expected_uid=expected_uid,
                expected_gid=expected_gid,
            )
        except OSError:
            fail()
        finally:
            if descriptor is not None:
                os.close(descriptor)


def acquire(descriptor: int, operation: int, wait_seconds: float) -> bool:
    deadline = time.monotonic() + max(0.0, wait_seconds)
    while True:
        try:
            fcntl.flock(descriptor, operation | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(POLL_SECONDS, remaining))


def producer_active() -> bool:
    return any(os.path.lexists(marker) for marker in PRODUCER_MARKERS)


def run_child(
    arguments: list[str], *, lock_descriptor: int, descriptor_environment: str
) -> int:
    try:
        environment = dict(os.environ)
        environment[descriptor_environment] = str(lock_descriptor)
        return subprocess.run(
            arguments,
            check=False,
            env=environment,
            pass_fds=(lock_descriptor,),
        ).returncode
    except OSError:
        return 70


def run_weekly() -> int:
    deadline = time.monotonic() + WEEKLY_PRODUCER_DEADLINE_SECONDS
    while producer_active():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 74
        time.sleep(min(10.0, remaining))
    with bound_lock(BACKUP_LOCK, create=False) as descriptor:
        if not acquire(descriptor, fcntl.LOCK_SH, deadline - time.monotonic()):
            return 74
        return run_child([
            "/usr/bin/timeout",
            "--signal=TERM",
            "--kill-after=15s",
            "5m",
            "/usr/bin/node",
            HEARTBEAT,
        ], lock_descriptor=descriptor, descriptor_environment="NEXUS_RELEASE_BACKUP_LOCK_FD")


def run_failure_only_inspect() -> int:
    if producer_active():
        return 74
    with bound_lock(BACKUP_LOCK, create=False) as descriptor:
        if not acquire(descriptor, fcntl.LOCK_SH, 0.0) or producer_active():
            return 74
        return run_child(
            [
                "/usr/bin/timeout",
                "--signal=TERM",
                "--kill-after=15s",
                "5m",
                "/usr/bin/node",
                HEARTBEAT,
                "--failure-only-inspect",
            ],
            lock_descriptor=descriptor,
            descriptor_environment="NEXUS_RELEASE_BACKUP_LOCK_FD",
        )


def run_alert_child(arguments: list[str]) -> int:
    with bound_lock(ALERT_LOCK, create=True) as descriptor:
        if not acquire(descriptor, fcntl.LOCK_EX, ALERT_LOCK_WAIT_SECONDS):
            return 75
        return run_child(
            arguments,
            lock_descriptor=descriptor,
            descriptor_environment="NEXUS_RELEASE_BACKUP_ALERT_LOCK_FD",
        )


def main(argv: list[str]) -> int:
    if argv == ["--weekly"]:
        return run_weekly()
    if argv == ["--failure-only-inspect"]:
        return run_failure_only_inspect()
    if argv == ["--alert-prepare"]:
        return run_alert_child(["/usr/bin/node", HEARTBEAT, "--failure-only-prepare"])
    if argv == ["--alert-force-prepare"]:
        return run_alert_child(["/usr/bin/node", HEARTBEAT, "--failure-only-force-prepare"])
    if len(argv) == 1 and argv[0].startswith("--alert-commit="):
        verdict = argv[0].removeprefix("--alert-commit=")
        if verdict not in VERDICTS:
            return 64
        return run_alert_child([
            "/usr/bin/node",
            HEARTBEAT,
            f"--failure-only-commit={verdict}",
        ])
    if len(argv) == 1 and argv[0].startswith("--operational="):
        unit = argv[0].removeprefix("--operational=")
        if unit not in OPERATION_UNITS:
            return 64
        return run_alert_child([
            "/usr/bin/node",
            OPERATIONAL_ALERT,
            f"--unit={unit}",
        ])
    return 64


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
