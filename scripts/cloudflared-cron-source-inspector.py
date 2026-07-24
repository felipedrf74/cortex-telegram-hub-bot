#!/usr/bin/env python3
"""Fail-closed inspection of Ubuntu cron command sources for cloudflared."""

import grp
import os
import stat


FOUND = 10
INSPECTION_ERROR = 20
NEEDLE = b"cloudflared"
SINGLE_FILES = (
    "/etc/crontab",
    "/etc/anacrontab",
)
COMMAND_DIRECTORIES = (
    "/etc/cron.d",
    "/etc/cron.hourly",
    "/etc/cron.daily",
    "/etc/cron.weekly",
    "/etc/cron.monthly",
    "/var/spool/cron/crontabs",
    "/var/spool/cron",
)
STABLE_FIELDS = (
    "st_dev",
    "st_ino",
    "st_mode",
    "st_uid",
    "st_gid",
    "st_size",
    "st_mtime_ns",
    "st_ctime_ns",
)
CRONTAB_SPOOL = "/var/spool/cron/crontabs"
CRONTAB_SPOOL_MODE = 0o1730


def inspection_error() -> None:
    raise SystemExit(INSPECTION_ERROR)


def under_trust_root(path: str, trust_root: str) -> bool:
    try:
        return os.path.commonpath((path, trust_root)) == trust_root
    except ValueError:
        return False


def validate_trusted_directory_chain(
    directory: str,
    *,
    trusted_uid: int,
    trust_root: str,
) -> None:
    current = os.path.abspath(directory)
    if not under_trust_root(current, trust_root):
        inspection_error()
    while True:
        observed = os.lstat(current)
        if (
            not stat.S_ISDIR(observed.st_mode)
            or stat.S_ISLNK(observed.st_mode)
            or observed.st_uid != trusted_uid
            or observed.st_mode & 0o022
        ):
            inspection_error()
        if current == trust_root:
            return
        parent = os.path.dirname(current)
        if parent == current:
            inspection_error()
        current = parent


def validate_trusted_regular_target(
    path: str,
    *,
    trusted_uid: int,
    trust_root: str,
) -> None:
    current = os.path.abspath(path)
    if not under_trust_root(current, trust_root):
        inspection_error()
    first = True
    while True:
        observed = os.lstat(current)
        if (
            stat.S_ISLNK(observed.st_mode)
            or observed.st_uid != trusted_uid
            or observed.st_mode & 0o022
            or (first and not stat.S_ISREG(observed.st_mode))
            or (not first and not stat.S_ISDIR(observed.st_mode))
        ):
            inspection_error()
        if current == trust_root:
            return
        first = False
        parent = os.path.dirname(current)
        if parent == current:
            inspection_error()
        current = parent


def validate_scan_directory(
    directory: str,
    observed: os.stat_result,
    *,
    trusted_uid: int,
    trust_root: str,
) -> None:
    absolute = os.path.abspath(directory)
    if (
        not under_trust_root(absolute, trust_root)
        or not stat.S_ISDIR(observed.st_mode)
        or stat.S_ISLNK(observed.st_mode)
        or observed.st_uid != trusted_uid
    ):
        inspection_error()
    permissions = stat.S_IMODE(observed.st_mode)
    if permissions & 0o022:
        # Debian's setgid crontab helper requires this exact sticky,
        # group-writable spool contract. Every other scan directory is
        # immutable to non-root users.
        if absolute != CRONTAB_SPOOL or permissions != CRONTAB_SPOOL_MODE:
            inspection_error()
        try:
            crontab_gid = grp.getgrnam("crontab").gr_gid
        except KeyError:
            inspection_error()
        if observed.st_gid != crontab_gid:
            inspection_error()
    validate_trusted_directory_chain(
        os.path.dirname(absolute),
        trusted_uid=trusted_uid,
        trust_root=trust_root,
    )


def inspect_file(
    path: str,
    *,
    directory_fd: int | None = None,
    directory_path: str | None = None,
    trusted_uid: int = 0,
    trust_root: str = "/",
) -> None:
    try:
        observed = os.stat(
            path,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        return
    except OSError:
        inspection_error()

    descriptor = None
    try:
        if stat.S_ISLNK(observed.st_mode):
            if observed.st_uid != trusted_uid:
                inspection_error()
            if directory_fd is None:
                source_directory = os.path.dirname(os.path.abspath(path))
                validate_trusted_directory_chain(
                    source_directory,
                    trusted_uid=trusted_uid,
                    trust_root=trust_root,
                )
            elif directory_path is not None:
                source_directory = os.path.abspath(directory_path)
            else:
                inspection_error()
            target = os.readlink(path, dir_fd=directory_fd)
            if os.path.isabs(target):
                resolved = os.path.normpath(target)
            else:
                resolved = os.path.normpath(
                    os.path.join(source_directory, target),
                )
            validate_trusted_regular_target(
                resolved,
                trusted_uid=trusted_uid,
                trust_root=trust_root,
            )
            descriptor = os.open(
                resolved,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            )
            path_identity = os.stat(
                path,
                dir_fd=directory_fd,
                follow_symlinks=True,
            )
        elif stat.S_ISREG(observed.st_mode):
            if directory_fd is None:
                validate_trusted_directory_chain(
                    os.path.dirname(os.path.abspath(path)),
                    trusted_uid=trusted_uid,
                    trust_root=trust_root,
                )
            descriptor = os.open(
                path,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
            path_identity = observed
        else:
            return

        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_dev != path_identity.st_dev
            or before.st_ino != path_identity.st_ino
        ):
            inspection_error()
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            for line in handle:
                stripped = line.lstrip()
                if (
                    stripped
                    and not stripped.startswith(b"#")
                    and NEEDLE in stripped.lower()
                ):
                    raise SystemExit(FOUND)
        after = os.fstat(descriptor)
        current_identity = os.stat(
            path,
            dir_fd=directory_fd,
            follow_symlinks=True,
        )
        if any(
            getattr(before, field) != getattr(after, field)
            for field in STABLE_FIELDS
        ):
            inspection_error()
        if (
            current_identity.st_dev != before.st_dev
            or current_identity.st_ino != before.st_ino
        ):
            inspection_error()
    except SystemExit:
        raise
    except OSError:
        inspection_error()
    finally:
        if descriptor is not None:
            os.close(descriptor)


def inspect_sources(
    single_files=SINGLE_FILES,
    command_directories=COMMAND_DIRECTORIES,
    *,
    trusted_uid: int = 0,
    trust_root: str = "/",
) -> None:
    trust_root = os.path.abspath(trust_root)
    for item in single_files:
        inspect_file(
            item,
            trusted_uid=trusted_uid,
            trust_root=trust_root,
        )

    for directory in command_directories:
        descriptor = None
        try:
            observed = os.stat(directory, follow_symlinks=False)
        except FileNotFoundError:
            continue
        except OSError:
            inspection_error()
        validate_scan_directory(
            directory,
            observed,
            trusted_uid=trusted_uid,
            trust_root=trust_root,
        )
        try:
            descriptor = os.open(
                directory,
                os.O_RDONLY
                | os.O_CLOEXEC
                | os.O_DIRECTORY
                | os.O_NOFOLLOW,
            )
            before = os.fstat(descriptor)
            if (
                before.st_dev != observed.st_dev
                or before.st_ino != observed.st_ino
            ):
                inspection_error()
            with os.scandir(descriptor) as entries:
                names = sorted(
                    entry.name
                    for entry in entries
                    if not entry.name.startswith(".")
                )
            for name in names:
                inspect_file(
                    name,
                    directory_fd=descriptor,
                    directory_path=directory,
                    trusted_uid=trusted_uid,
                    trust_root=trust_root,
                )
            after = os.fstat(descriptor)
            current_identity = os.stat(directory, follow_symlinks=False)
            if any(
                getattr(before, field) != getattr(after, field)
                for field in STABLE_FIELDS
            ):
                inspection_error()
            if (
                current_identity.st_dev != before.st_dev
                or current_identity.st_ino != before.st_ino
            ):
                inspection_error()
        except SystemExit:
            raise
        except OSError:
            inspection_error()
        finally:
            if descriptor is not None:
                os.close(descriptor)


if __name__ == "__main__":
    inspect_sources()
