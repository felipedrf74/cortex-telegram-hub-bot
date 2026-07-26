#!/usr/bin/env python3
"""Descriptor-bound filesystem operations for the legacy staging drill.

The legacy staging base is shared with an unprivileged release worker.  This
helper keeps every privileged release-tree operation rooted in O_NOFOLLOW
directory descriptors and binds the release directory device/inode before and
after mutation or command execution.  It deliberately does not use os.walk().
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import sqlite3
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import NoReturn, Optional


DIRECTORY_FLAGS = (
    os.O_RDONLY
    | os.O_DIRECTORY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
FILE_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
METADATA_SCHEMA = "nexus.rollback-drill-runtime-metadata.v1"
MAX_RUNTIME_INODES = 500_000
MAX_PROC_PIDS = 131_072
MAX_PROC_FDS = 1_048_576
MAX_PROC_MAP_BYTES = 256 * 1024 * 1024
MAX_PROC_MAP_BYTES_PER_PID = 16 * 1024 * 1024


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def canonical_absolute(value: str, label: str) -> str:
    if (
        not value
        or not os.path.isabs(value)
        or os.path.normpath(value) != value
        or value == "/"
    ):
        fail(f"{label} is not a canonical absolute path")
    return value


def open_absolute(directory: str) -> int:
    canonical_absolute(directory, "directory")
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for component in directory.split(os.sep)[1:]:
            child = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def identity(observed: os.stat_result) -> dict[str, object]:
    return {
        "dev": str(observed.st_dev),
        "ino": str(observed.st_ino),
        "uid": observed.st_uid,
        "gid": observed.st_gid,
        "mode": stat.S_IMODE(observed.st_mode),
    }


def expected_identity(args: argparse.Namespace) -> tuple[str, str]:
    if not args.expect_dev or not args.expect_ino:
        fail("bound runtime device and inode are required")
    return args.expect_dev, args.expect_ino


def assert_identity(
    observed: os.stat_result,
    expected: tuple[str, str],
    label: str,
) -> None:
    if (
        not stat.S_ISDIR(observed.st_mode)
        or str(observed.st_dev) != expected[0]
        or str(observed.st_ino) != expected[1]
    ):
        fail(f"{label} device/inode identity changed")


def root_identity(args: argparse.Namespace) -> tuple[int, int]:
    if args.test_mode:
        return os.getuid(), os.getgid()
    return 0, 0


def open_release_context(
    args: argparse.Namespace,
    *,
    runtime: Optional[str] = None,
    expected: Optional[tuple[str, str]] = None,
) -> tuple[int, int, Optional[int]]:
    base = canonical_absolute(args.base, "legacy staging base")
    releases = os.path.join(base, "releases")
    root_uid, root_gid = root_identity(args)
    base_fd = open_absolute(base)
    release_fd: Optional[int] = None
    runtime_fd: Optional[int] = None
    try:
        base_stat = os.fstat(base_fd)
        if (
            not stat.S_ISDIR(base_stat.st_mode)
            or base_stat.st_uid != root_uid
            or base_stat.st_gid != root_gid
            or stat.S_IMODE(base_stat.st_mode) != 0o755
        ):
            fail("legacy staging base is not root-owned mode 0755")
        release_fd = os.open("releases", DIRECTORY_FLAGS, dir_fd=base_fd)
        release_stat = os.fstat(release_fd)
        if (
            not stat.S_ISDIR(release_stat.st_mode)
            or release_stat.st_uid != root_uid
            or release_stat.st_gid != root_gid
            or stat.S_IMODE(release_stat.st_mode) != 0o755
        ):
            fail("legacy staging releases parent is not root-owned mode 0755")
        if runtime is not None:
            runtime = canonical_absolute(runtime, "runtime")
            if os.path.dirname(runtime) != releases:
                fail("runtime is outside the governed releases parent")
            name = os.path.basename(runtime)
            runtime_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=release_fd)
            if expected is not None:
                assert_identity(os.fstat(runtime_fd), expected, "runtime")
        return base_fd, release_fd, runtime_fd
    except BaseException:
        if runtime_fd is not None:
            os.close(runtime_fd)
        if release_fd is not None:
            os.close(release_fd)
        os.close(base_fd)
        raise


def close_context(
    base_fd: int,
    release_fd: int,
    runtime_fd: Optional[int],
) -> None:
    if runtime_fd is not None:
        os.close(runtime_fd)
    os.close(release_fd)
    os.close(base_fd)


def assert_runtime_path(
    release_fd: int,
    runtime: str,
    expected: tuple[str, str],
    label: str,
) -> None:
    reopened = os.open(
        os.path.basename(runtime),
        DIRECTORY_FLAGS,
        dir_fd=release_fd,
    )
    try:
        assert_identity(os.fstat(reopened), expected, label)
    finally:
        os.close(reopened)


def sorted_entries(directory_fd: int) -> list[str]:
    names = sorted(entry.name for entry in os.scandir(directory_fd))
    for name in names:
        pure = PurePosixPath(name)
        if name in ("", ".", "..") or len(pure.parts) != 1:
            fail("runtime contains an invalid entry name")
    return names


def scan_metadata(
    directory_fd: int,
    relative: str,
    output: list[dict[str, object]],
) -> None:
    for name in sorted_entries(directory_fd):
        observed = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        child_relative = name if relative == "." else f"{relative}/{name}"
        if stat.S_ISLNK(observed.st_mode):
            kind = "symlink"
        elif stat.S_ISREG(observed.st_mode):
            if observed.st_nlink != 1:
                fail("runtime contains a hard-linked regular file")
            kind = "file"
        elif stat.S_ISDIR(observed.st_mode):
            kind = "directory"
        else:
            fail("runtime contains an unsupported filesystem entry")
        output.append({
            "path": child_relative,
            "kind": kind,
            "uid": observed.st_uid,
            "gid": observed.st_gid,
            "mode": stat.S_IMODE(observed.st_mode),
        })
        if kind == "directory":
            child_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=directory_fd)
            try:
                scan_metadata(child_fd, child_relative, output)
            finally:
                os.close(child_fd)


def atomic_json(output: str, value: object) -> None:
    output = canonical_absolute(output, "metadata output")
    parent = os.path.dirname(output)
    parent_fd = open_absolute(parent)
    temporary = f".{os.path.basename(output)}.next.{secrets.token_hex(12)}"
    descriptor: Optional[int] = None
    try:
        try:
            os.stat(
                os.path.basename(output),
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        else:
            fail("metadata output already exists")
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=parent_fd,
        )
        body = f"{json.dumps(value, indent=2)}\n".encode()
        view = memoryview(body)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                fail("metadata output write was incomplete")
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.link(
            temporary,
            os.path.basename(output),
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
            follow_symlinks=False,
        )
        os.fsync(parent_fd)
        os.unlink(temporary, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)


def assert_sealed_recursive(
    directory_fd: int,
    root_uid: int,
    root_gid: int,
) -> None:
    observed_directory = os.fstat(directory_fd)
    if (
        observed_directory.st_uid != root_uid
        or observed_directory.st_gid != root_gid
        or stat.S_IMODE(observed_directory.st_mode) != 0o555
    ):
        fail("sealed runtime directory identity drifted")
    for name in sorted_entries(directory_fd):
        observed = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if observed.st_uid != root_uid or observed.st_gid != root_gid:
            fail("sealed runtime entry ownership drifted")
        if stat.S_ISLNK(observed.st_mode):
            continue
        if stat.S_ISDIR(observed.st_mode):
            if stat.S_IMODE(observed.st_mode) != 0o555:
                fail("sealed runtime directory became writable")
            child_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=directory_fd)
            try:
                assert_sealed_recursive(child_fd, root_uid, root_gid)
            finally:
                os.close(child_fd)
            continue
        if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1:
            fail("sealed runtime entry type is unsafe")
        expected_mode = 0o555 if observed.st_mode & 0o111 else 0o444
        if stat.S_IMODE(observed.st_mode) != expected_mode:
            fail("sealed runtime file mode drifted")


def seal_recursive(directory_fd: int, root_uid: int, root_gid: int) -> None:
    # Freeze the directory before enumerating it.  Once its parent was frozen,
    # neither the worker nor a retained pathname can replace this directory.
    os.fchown(directory_fd, root_uid, root_gid)
    os.fchmod(directory_fd, 0o555)
    for name in sorted_entries(directory_fd):
        observed = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISLNK(observed.st_mode):
            os.chown(
                name,
                root_uid,
                root_gid,
                dir_fd=directory_fd,
                follow_symlinks=False,
            )
            continue
        if stat.S_ISDIR(observed.st_mode):
            child_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=directory_fd)
            try:
                seal_recursive(child_fd, root_uid, root_gid)
            finally:
                os.close(child_fd)
            continue
        if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1:
            fail("runtime contains an unsupported mutable entry")
        descriptor = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
        try:
            opened = os.fstat(descriptor)
            if (
                opened.st_dev != observed.st_dev
                or opened.st_ino != observed.st_ino
                or opened.st_nlink != 1
            ):
                fail("runtime entry changed while it was sealed")
            os.fchown(descriptor, root_uid, root_gid)
            os.fchmod(descriptor, 0o555 if opened.st_mode & 0o111 else 0o444)
        finally:
            os.close(descriptor)


def collect_runtime_inodes(
    directory_fd: int,
    inodes: set[tuple[int, int]],
) -> None:
    observed_directory = os.fstat(directory_fd)
    inodes.add((observed_directory.st_dev, observed_directory.st_ino))
    if len(inodes) > MAX_RUNTIME_INODES:
        fail("runtime inode inventory exceeds its safety bound")
    for name in sorted_entries(directory_fd):
        observed = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        inodes.add((observed.st_dev, observed.st_ino))
        if len(inodes) > MAX_RUNTIME_INODES:
            fail("runtime inode inventory exceeds its safety bound")
        if stat.S_ISDIR(observed.st_mode):
            child_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=directory_fd)
            try:
                opened = os.fstat(child_fd)
                if (
                    opened.st_dev != observed.st_dev
                    or opened.st_ino != observed.st_ino
                ):
                    fail("runtime changed during inode inventory")
                collect_runtime_inodes(child_fd, inodes)
            finally:
                os.close(child_fd)


def read_bounded_proc_file(
    directory_fd: int,
    name: str,
    maximum: int,
) -> bytes:
    descriptor = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
    try:
        blocks: list[bytes] = []
        size = 0
        while True:
            block = os.read(descriptor, min(64 * 1024, maximum + 1 - size))
            if not block:
                break
            blocks.append(block)
            size += len(block)
            if size > maximum:
                fail("procfs inspection exceeds its safety bound")
        return b"".join(blocks)
    finally:
        os.close(descriptor)


def process_still_exists(proc_fd: int, pid: str) -> bool:
    try:
        observed = os.stat(pid, dir_fd=proc_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(observed.st_mode):
        fail("procfs process entry changed type during inspection")
    return True


def parse_fd_access_mode(body: bytes) -> int:
    try:
        lines = body.decode("ascii").splitlines()
    except UnicodeDecodeError as error:
        raise SystemExit("procfs descriptor metadata is not ASCII") from error
    values = [
        line.split(":", 1)[1].strip()
        for line in lines
        if line.startswith("flags:") and ":" in line
    ]
    if len(values) != 1 or not re.fullmatch(r"[0-7]+", values[0]):
        fail("procfs descriptor flags are incomplete")
    return int(values[0], 8) & os.O_ACCMODE


def assert_no_writable_proc_references(
    proc_fd: int,
    runtime_inodes: set[tuple[int, int]],
) -> dict[str, int]:
    pid_names = sorted(
        entry.name
        for entry in os.scandir(proc_fd)
        if entry.name.isascii() and entry.name.isdigit()
    )
    if len(pid_names) > MAX_PROC_PIDS:
        fail("procfs process inventory exceeds its safety bound")
    inspected_processes = 0
    inspected_descriptors = 0
    inspected_map_bytes = 0
    for pid in pid_names:
        pid_fd: Optional[int] = None
        descriptors_fd: Optional[int] = None
        descriptor_info_fd: Optional[int] = None
        try:
            try:
                pid_fd = os.open(pid, DIRECTORY_FLAGS, dir_fd=proc_fd)
            except FileNotFoundError:
                continue
            inspected_processes += 1
            try:
                descriptors_fd = os.open("fd", DIRECTORY_FLAGS, dir_fd=pid_fd)
                descriptor_info_fd = os.open(
                    "fdinfo",
                    DIRECTORY_FLAGS,
                    dir_fd=pid_fd,
                )
            except FileNotFoundError:
                if process_still_exists(proc_fd, pid):
                    fail("procfs descriptor inventory is incomplete")
                continue
            descriptor_names = sorted(
                entry.name
                for entry in os.scandir(descriptors_fd)
                if entry.name.isascii() and entry.name.isdigit()
            )
            inspected_descriptors += len(descriptor_names)
            if inspected_descriptors > MAX_PROC_FDS:
                fail("procfs descriptor inventory exceeds its safety bound")
            for descriptor_name in descriptor_names:
                try:
                    before = os.stat(
                        descriptor_name,
                        dir_fd=descriptors_fd,
                        follow_symlinks=True,
                    )
                    flags = parse_fd_access_mode(read_bounded_proc_file(
                        descriptor_info_fd,
                        descriptor_name,
                        64 * 1024,
                    ))
                    after = os.stat(
                        descriptor_name,
                        dir_fd=descriptors_fd,
                        follow_symlinks=True,
                    )
                except FileNotFoundError:
                    try:
                        os.stat(
                            descriptor_name,
                            dir_fd=descriptors_fd,
                            follow_symlinks=True,
                        )
                    except FileNotFoundError:
                        continue
                    fail("procfs descriptor metadata is incomplete")
                if (
                    before.st_dev != after.st_dev
                    or before.st_ino != after.st_ino
                    or before.st_mode != after.st_mode
                ):
                    fail("procfs descriptor changed during inspection")
                if (
                    (before.st_dev, before.st_ino) in runtime_inodes
                    and flags in (os.O_WRONLY, os.O_RDWR)
                ):
                    fail("sealed runtime retains a writable file descriptor")
            try:
                maps = read_bounded_proc_file(
                    pid_fd,
                    "maps",
                    MAX_PROC_MAP_BYTES_PER_PID,
                )
            except FileNotFoundError:
                if process_still_exists(proc_fd, pid):
                    fail("procfs writable mapping inventory is incomplete")
                continue
            inspected_map_bytes += len(maps)
            if inspected_map_bytes > MAX_PROC_MAP_BYTES:
                fail("procfs mapping inventory exceeds its safety bound")
            try:
                map_lines = maps.decode("utf-8").splitlines()
            except UnicodeDecodeError as error:
                raise SystemExit("procfs mapping inventory is not UTF-8") from error
            for line in map_lines:
                fields = line.split(maxsplit=5)
                if len(fields) < 5:
                    fail("procfs mapping inventory contains an invalid record")
                permissions = fields[1]
                device = fields[3]
                inode_value = fields[4]
                if (
                    len(permissions) != 4
                    or permissions[0] not in "r-"
                    or permissions[1] not in "w-"
                    or permissions[2] not in "x-"
                    or permissions[3] not in "ps"
                    or not re.fullmatch(r"[0-9a-fA-F]+:[0-9a-fA-F]+", device)
                    or not inode_value.isascii()
                    or not inode_value.isdigit()
                ):
                    fail("procfs mapping inventory contains an invalid record")
                if permissions[1] != "w" or inode_value == "0":
                    continue
                major_value, minor_value = (
                    int(value, 16) for value in device.split(":", 1)
                )
                inode = (os.makedev(major_value, minor_value), int(inode_value))
                if inode in runtime_inodes:
                    fail("sealed runtime retains a writable file mapping")
        except PermissionError as error:
            raise SystemExit("procfs inspection is not permitted") from error
        finally:
            if descriptor_info_fd is not None:
                os.close(descriptor_info_fd)
            if descriptors_fd is not None:
                os.close(descriptors_fd)
            if pid_fd is not None:
                os.close(pid_fd)
    return {
        "processes": inspected_processes,
        "descriptors": inspected_descriptors,
        "mappingBytes": inspected_map_bytes,
    }


def open_relative_directory(root_fd: int, relative: str) -> int:
    descriptor = os.dup(root_fd)
    try:
        if relative == ".":
            return descriptor
        for component in PurePosixPath(relative).parts:
            child = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def validate_metadata(value: object, observed: os.stat_result) -> list[dict[str, object]]:
    if (
        not isinstance(value, dict)
        or value.get("schema") != METADATA_SCHEMA
        or value.get("runtimeIdentity", {}).get("dev") != str(observed.st_dev)
        or value.get("runtimeIdentity", {}).get("ino") != str(observed.st_ino)
        or not isinstance(value.get("entries"), list)
    ):
        fail("runtime metadata journal is invalid")
    entries = value["entries"]
    expected_paths: set[str] = set()
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or set(entry) != {"gid", "kind", "mode", "path", "uid"}
            or entry["kind"] not in {"directory", "file", "symlink"}
            or not isinstance(entry["path"], str)
            or entry["path"] in expected_paths
            or entry["path"] == ""
            or (
                entry["path"] != "."
                and (
                    PurePosixPath(entry["path"]).is_absolute()
                    or ".." in PurePosixPath(entry["path"]).parts
                    or "." in PurePosixPath(entry["path"]).parts
                )
            )
            or not isinstance(entry["uid"], int)
            or not isinstance(entry["gid"], int)
            or not isinstance(entry["mode"], int)
            or entry["mode"] < 0
            or entry["mode"] > 0o7777
        ):
            fail("runtime metadata entry is invalid")
        expected_paths.add(entry["path"])
    if "." not in expected_paths:
        fail("runtime root metadata is missing")
    return entries


def restore_metadata(
    runtime_fd: int,
    entries: list[dict[str, object]],
    root_uid: int,
    root_gid: int,
) -> None:
    # First make every governed directory root-private.  This retains exclusive
    # mutation authority while child metadata is restored.
    directories = sorted(
        (entry for entry in entries if entry["kind"] == "directory"),
        key=lambda entry: (entry["path"].count("/"), entry["path"]),
    )
    for entry in directories:
        descriptor = open_relative_directory(runtime_fd, entry["path"])
        try:
            os.fchown(descriptor, root_uid, root_gid)
            os.fchmod(descriptor, 0o700)
        finally:
            os.close(descriptor)

    for entry in sorted(
        (item for item in entries if item["kind"] != "directory"),
        key=lambda item: item["path"],
    ):
        parent = str(PurePosixPath(entry["path"]).parent)
        name = PurePosixPath(entry["path"]).name
        parent_fd = open_relative_directory(runtime_fd, parent)
        try:
            observed = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            expected_kind = (
                "symlink"
                if stat.S_ISLNK(observed.st_mode)
                else "file"
                if stat.S_ISREG(observed.st_mode) and observed.st_nlink == 1
                else "invalid"
            )
            if expected_kind != entry["kind"]:
                fail("runtime entry type changed before metadata restore")
            if entry["kind"] == "symlink":
                os.chown(
                    name,
                    entry["uid"],
                    entry["gid"],
                    dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            else:
                descriptor = os.open(name, FILE_FLAGS, dir_fd=parent_fd)
                try:
                    os.fchown(descriptor, entry["uid"], entry["gid"])
                    os.fchmod(descriptor, entry["mode"])
                finally:
                    os.close(descriptor)
        finally:
            os.close(parent_fd)

    for entry in sorted(
        directories,
        key=lambda item: (item["path"].count("/"), item["path"]),
        reverse=True,
    ):
        descriptor = open_relative_directory(runtime_fd, entry["path"])
        try:
            os.fchown(descriptor, entry["uid"], entry["gid"])
            os.fchmod(descriptor, entry["mode"])
        finally:
            os.close(descriptor)


def pause_if_requested(args: argparse.Namespace, prefix: str) -> None:
    marker = getattr(args, f"{prefix}_marker", "")
    resume = getattr(args, f"{prefix}_resume", "")
    if not args.test_mode or not marker or not resume:
        return
    descriptor = os.open(
        marker,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    os.close(descriptor)
    for _ in range(1000):
        if os.path.exists(resume):
            return
        time.sleep(0.01)
    fail("descriptor race test timed out")


def command_assert_parents(args: argparse.Namespace) -> None:
    base_fd, release_fd, _ = open_release_context(args)
    close_context(base_fd, release_fd, None)
    print(json.dumps({"ok": True}))


def command_prepare_release(args: argparse.Namespace) -> None:
    runtime = canonical_absolute(args.runtime, "runtime")
    base_fd, release_fd, _ = open_release_context(args)
    name = os.path.basename(runtime)
    runtime_fd: Optional[int] = None
    try:
        if os.path.dirname(runtime) != os.path.join(args.base, "releases"):
            fail("prepared runtime escapes releases parent")
        try:
            os.stat(name, dir_fd=release_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            fail("prepared runtime already exists")
        os.mkdir(name, 0o700, dir_fd=release_fd)
        runtime_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=release_fd)
        os.fchmod(runtime_fd, 0o700)
        if not args.test_mode:
            os.fchown(runtime_fd, args.worker_uid, args.worker_gid)
        observed = os.fstat(runtime_fd)
        expected_uid = os.getuid() if args.test_mode else args.worker_uid
        expected_gid = os.getgid() if args.test_mode else args.worker_gid
        if (
            observed.st_uid != expected_uid
            or observed.st_gid != expected_gid
            or stat.S_IMODE(observed.st_mode) != 0o700
        ):
            fail("prepared runtime identity is unsafe")
        os.fsync(release_fd)
        print(json.dumps(identity(observed), separators=(",", ":")))
    except BaseException:
        if runtime_fd is not None:
            os.close(runtime_fd)
            runtime_fd = None
        try:
            os.rmdir(name, dir_fd=release_fd)
        except OSError:
            pass
        raise
    finally:
        if runtime_fd is not None:
            os.close(runtime_fd)
        close_context(base_fd, release_fd, None)


def command_capture(args: argparse.Namespace) -> None:
    expected = expected_identity(args)
    base_fd, release_fd, runtime_fd = open_release_context(
        args,
        runtime=args.runtime,
        expected=expected,
    )
    assert runtime_fd is not None
    try:
        root_stat = os.fstat(runtime_fd)
        entries: list[dict[str, object]] = [{
            "path": ".",
            "kind": "directory",
            "uid": root_stat.st_uid,
            "gid": root_stat.st_gid,
            "mode": stat.S_IMODE(root_stat.st_mode),
        }]
        scan_metadata(runtime_fd, ".", entries)
        atomic_json(args.output, {
            "schema": METADATA_SCHEMA,
            "runtime": args.runtime,
            "runtimeIdentity": identity(root_stat),
            "entries": entries,
        })
    finally:
        close_context(base_fd, release_fd, runtime_fd)
    print(json.dumps({"ok": True}))


def command_seal(args: argparse.Namespace) -> None:
    expected = expected_identity(args)
    base_fd, release_fd, runtime_fd = open_release_context(
        args,
        runtime=args.runtime,
        expected=expected,
    )
    assert runtime_fd is not None
    try:
        pause_if_requested(args, "seal")
        assert_runtime_path(
            release_fd,
            args.runtime,
            expected,
            "runtime path before sealing",
        )
        root_uid, root_gid = root_identity(args)
        seal_recursive(runtime_fd, root_uid, root_gid)
        os.fsync(runtime_fd)
        assert_identity(os.fstat(runtime_fd), expected, "sealed runtime")
        assert_sealed_recursive(runtime_fd, root_uid, root_gid)
        reopened = os.open(
            os.path.basename(args.runtime),
            DIRECTORY_FLAGS,
            dir_fd=release_fd,
        )
        try:
            assert_identity(os.fstat(reopened), expected, "sealed runtime path")
        finally:
            os.close(reopened)
    finally:
        close_context(base_fd, release_fd, runtime_fd)
    print(json.dumps({"ok": True}))


def command_assert_sealed(args: argparse.Namespace) -> None:
    expected = expected_identity(args)
    base_fd, release_fd, runtime_fd = open_release_context(
        args,
        runtime=args.runtime,
        expected=expected,
    )
    assert runtime_fd is not None
    try:
        root_uid, root_gid = root_identity(args)
        assert_sealed_recursive(runtime_fd, root_uid, root_gid)
    finally:
        close_context(base_fd, release_fd, runtime_fd)
    print(json.dumps({"ok": True}))


def command_assert_no_writable_references(args: argparse.Namespace) -> None:
    expected = expected_identity(args)
    proc_root = canonical_absolute(args.proc_root, "procfs root")
    if not args.test_mode and proc_root != "/proc":
        fail("production procfs root may not be overridden")
    base_fd, release_fd, runtime_fd = open_release_context(
        args,
        runtime=args.runtime,
        expected=expected,
    )
    assert runtime_fd is not None
    proc_fd: Optional[int] = None
    try:
        root_uid, root_gid = root_identity(args)
        assert_sealed_recursive(runtime_fd, root_uid, root_gid)
        runtime_inodes: set[tuple[int, int]] = set()
        collect_runtime_inodes(runtime_fd, runtime_inodes)
        assert_identity(os.fstat(runtime_fd), expected, "inventoried runtime")
        assert_runtime_path(
            release_fd,
            args.runtime,
            expected,
            "inventoried runtime path",
        )
        proc_fd = open_absolute(proc_root)
        inventory = assert_no_writable_proc_references(
            proc_fd,
            runtime_inodes,
        )
        assert_identity(os.fstat(runtime_fd), expected, "inspected runtime")
        assert_sealed_recursive(runtime_fd, root_uid, root_gid)
        assert_runtime_path(
            release_fd,
            args.runtime,
            expected,
            "inspected runtime path",
        )
    finally:
        if proc_fd is not None:
            os.close(proc_fd)
        close_context(base_fd, release_fd, runtime_fd)
    print(json.dumps({
        "ok": True,
        "runtimeInodes": len(runtime_inodes),
        **inventory,
    }, separators=(",", ":")))


def command_assert_runtime(args: argparse.Namespace) -> None:
    expected = expected_identity(args)
    base_fd, release_fd, runtime_fd = open_release_context(
        args,
        runtime=args.runtime,
        expected=expected,
    )
    assert runtime_fd is not None
    try:
        observed = os.fstat(runtime_fd)
        root_uid, root_gid = root_identity(args)
        worker_uid = os.getuid() if args.test_mode else args.worker_uid
        worker_gid = os.getgid() if args.test_mode else args.worker_gid
        mutable = (
            observed.st_uid == worker_uid
            and observed.st_gid == worker_gid
            and stat.S_IMODE(observed.st_mode) == 0o700
        )
        sealed = (
            observed.st_uid == root_uid
            and observed.st_gid == root_gid
            and stat.S_IMODE(observed.st_mode) == 0o555
        )
        if not (mutable or sealed):
            fail("runtime ownership or mode is outside its governed lifecycle")
        if sealed:
            assert_sealed_recursive(runtime_fd, root_uid, root_gid)
    finally:
        close_context(base_fd, release_fd, runtime_fd)
    print(json.dumps({"ok": True}))


def command_runtime_identity(args: argparse.Namespace) -> None:
    base_fd, release_fd, runtime_fd = open_release_context(
        args,
        runtime=args.runtime,
    )
    assert runtime_fd is not None
    try:
        print(json.dumps(identity(os.fstat(runtime_fd)), separators=(",", ":")))
    finally:
        close_context(base_fd, release_fd, runtime_fd)


def command_restore_metadata(args: argparse.Namespace) -> None:
    expected = expected_identity(args)
    base_fd, release_fd, runtime_fd = open_release_context(
        args,
        runtime=args.runtime,
        expected=expected,
    )
    assert runtime_fd is not None
    metadata_fd = os.open(args.metadata, FILE_FLAGS)
    try:
        metadata_stat = os.fstat(metadata_fd)
        if not stat.S_ISREG(metadata_stat.st_mode) or metadata_stat.st_nlink != 1:
            fail("runtime metadata journal is unsafe")
        value = json.load(os.fdopen(os.dup(metadata_fd), "r", encoding="utf-8"))
        entries = validate_metadata(value, os.fstat(runtime_fd))
        observed: list[dict[str, object]] = [{
            "path": ".",
            "kind": "directory",
            "uid": os.fstat(runtime_fd).st_uid,
            "gid": os.fstat(runtime_fd).st_gid,
            "mode": stat.S_IMODE(os.fstat(runtime_fd).st_mode),
        }]
        scan_metadata(runtime_fd, ".", observed)
        if {entry["path"] for entry in observed} != {
            entry["path"] for entry in entries
        }:
            fail("runtime tree changed before metadata restore")
        root_uid, root_gid = root_identity(args)
        restore_metadata(runtime_fd, entries, root_uid, root_gid)
        reopened = os.open(
            os.path.basename(args.runtime),
            DIRECTORY_FLAGS,
            dir_fd=release_fd,
        )
        try:
            assert_identity(os.fstat(reopened), expected, "restored runtime path")
        finally:
            os.close(reopened)
    finally:
        os.close(metadata_fd)
        close_context(base_fd, release_fd, runtime_fd)
    print(json.dumps({"ok": True}))


def command_guarded_exec(args: argparse.Namespace) -> None:
    expected = expected_identity(args)
    base_fd, release_fd, runtime_fd = open_release_context(
        args,
        runtime=args.runtime,
        expected=expected,
    )
    assert runtime_fd is not None
    try:
        root_uid, root_gid = root_identity(args)
        assert_sealed_recursive(runtime_fd, root_uid, root_gid)
        pause_if_requested(args, "exec")
        assert_runtime_path(
            release_fd,
            args.runtime,
            expected,
            "runtime path before execution",
        )
        if not args.command:
            fail("guarded runtime command is missing")
        result = subprocess.run(
            args.command,
            check=False,
            pass_fds=(
                base_fd,
                release_fd,
                runtime_fd,
                *(args.pass_fd or []),
            ),
        )
        reopened = os.open(
            os.path.basename(args.runtime),
            DIRECTORY_FLAGS,
            dir_fd=release_fd,
        )
        try:
            assert_identity(os.fstat(reopened), expected, "executed runtime path")
        finally:
            os.close(reopened)
        assert_identity(os.fstat(runtime_fd), expected, "executed runtime")
        assert_sealed_recursive(runtime_fd, root_uid, root_gid)
        if result.returncode != 0:
            raise SystemExit(result.returncode)
    finally:
        close_context(base_fd, release_fd, runtime_fd)


def selector_identity(
    base_fd: int,
    release_fd: int,
    expected: str,
    expected_fd: int,
) -> dict[str, object]:
    observed = os.stat("current", dir_fd=base_fd, follow_symlinks=False)
    if not stat.S_ISLNK(observed.st_mode):
        fail("legacy staging selector is not a symlink")
    target = os.readlink("current", dir_fd=base_fd)
    if target != expected:
        fail("legacy staging selector target changed")
    target_fd = os.open(
        os.path.basename(expected),
        DIRECTORY_FLAGS,
        dir_fd=release_fd,
    )
    try:
        target_stat = os.fstat(target_fd)
        expected_stat = os.fstat(expected_fd)
        if (
            target_stat.st_dev != expected_stat.st_dev
            or target_stat.st_ino != expected_stat.st_ino
        ):
            fail("legacy staging selector runtime identity changed")
    finally:
        os.close(target_fd)
    return {
        "path": "",
        "target": target,
        "dev": str(observed.st_dev),
        "ino": str(observed.st_ino),
        "uid": observed.st_uid,
        "gid": observed.st_gid,
        "mode": stat.S_IMODE(observed.st_mode),
    }


def command_selector_json(args: argparse.Namespace) -> None:
    expected = canonical_absolute(args.expected, "selector target")
    base_fd, release_fd, expected_fd = open_release_context(
        args,
        runtime=expected,
    )
    assert expected_fd is not None
    try:
        if args.expect_dev and args.expect_ino:
            assert_identity(
                os.fstat(expected_fd),
                (args.expect_dev, args.expect_ino),
                "selector target",
            )
        value = selector_identity(base_fd, release_fd, expected, expected_fd)
        value["path"] = os.path.join(args.base, "current")
        print(json.dumps(value, separators=(",", ":")))
    finally:
        close_context(base_fd, release_fd, expected_fd)


def command_current_identity(args: argparse.Namespace) -> None:
    base_fd, release_fd, _ = open_release_context(args)
    runtime_fd: Optional[int] = None
    try:
        observed = os.stat("current", dir_fd=base_fd, follow_symlinks=False)
        if not stat.S_ISLNK(observed.st_mode):
            fail("legacy staging current selector is not a symlink")
        target = os.readlink("current", dir_fd=base_fd)
        if (
            not os.path.isabs(target)
            or os.path.dirname(target) != os.path.join(args.base, "releases")
        ):
            fail("legacy staging current selector target is unsafe")
        runtime_fd = os.open(
            os.path.basename(target),
            DIRECTORY_FLAGS,
            dir_fd=release_fd,
        )
        print(json.dumps({
            "runtime": target,
            "runtimeIdentity": identity(os.fstat(runtime_fd)),
            "selector": {
                "path": os.path.join(args.base, "current"),
                "target": target,
                "dev": str(observed.st_dev),
                "ino": str(observed.st_ino),
                "uid": observed.st_uid,
                "gid": observed.st_gid,
                "mode": stat.S_IMODE(observed.st_mode),
            },
        }, separators=(",", ":")))
    finally:
        if runtime_fd is not None:
            os.close(runtime_fd)
        close_context(base_fd, release_fd, None)


def command_switch_selector(args: argparse.Namespace) -> None:
    expected = canonical_absolute(args.expected, "expected selector target")
    target = canonical_absolute(args.target, "new selector target")
    base_fd, release_fd, expected_fd = open_release_context(
        args,
        runtime=expected,
    )
    assert expected_fd is not None
    target_fd: Optional[int] = None
    temporary = f".current.legacy-drill.{secrets.token_hex(12)}"
    try:
        if args.expect_dev and args.expect_ino:
            assert_identity(
                os.fstat(expected_fd),
                (args.expect_dev, args.expect_ino),
                "expected selector target",
            )
        if os.path.dirname(target) != os.path.join(args.base, "releases"):
            fail("new selector target escapes releases parent")
        target_fd = os.open(
            os.path.basename(target),
            DIRECTORY_FLAGS,
            dir_fd=release_fd,
        )
        target_stat = os.fstat(target_fd)
        if args.target_dev and args.target_ino:
            assert_identity(
                target_stat,
                (args.target_dev, args.target_ino),
                "new selector target",
            )
        selector_identity(base_fd, release_fd, expected, expected_fd)
        root_uid, root_gid = root_identity(args)
        assert_sealed_recursive(target_fd, root_uid, root_gid)
        pause_if_requested(args, "switch")
        assert_runtime_path(
            release_fd,
            expected,
            (args.expect_dev, args.expect_ino),
            "expected selector target before publication",
        )
        assert_runtime_path(
            release_fd,
            target,
            (args.target_dev, args.target_ino),
            "new selector target before publication",
        )
        os.symlink(target, temporary, dir_fd=base_fd)
        os.replace(
            temporary,
            "current",
            src_dir_fd=base_fd,
            dst_dir_fd=base_fd,
        )
        os.fsync(base_fd)
        reopened = os.open(
            os.path.basename(target),
            DIRECTORY_FLAGS,
            dir_fd=release_fd,
        )
        try:
            assert_identity(os.fstat(reopened), (
                str(target_stat.st_dev),
                str(target_stat.st_ino),
            ), "published selector target")
        finally:
            os.close(reopened)
        selector_identity(base_fd, release_fd, target, target_fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=base_fd)
        except FileNotFoundError:
            pass
        if target_fd is not None:
            os.close(target_fd)
        close_context(base_fd, release_fd, expected_fd)
    print(json.dumps({"ok": True}))


def fsync_directory_fd(directory_fd: int) -> None:
    os.fsync(directory_fd)


def digest_fd(descriptor: int) -> tuple[str, int]:
    os.lseek(descriptor, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    size = 0
    while True:
        block = os.read(descriptor, 1024 * 1024)
        if not block:
            break
        digest.update(block)
        size += len(block)
        if size > args_max_database_bytes():
            fail("database exceeds its size bound")
    os.lseek(descriptor, 0, os.SEEK_SET)
    return digest.hexdigest(), size


def args_max_database_bytes() -> int:
    return 2 * 1024 * 1024 * 1024


def descriptor_path(descriptor: int, child: str = "") -> str:
    root = "/proc/self/fd" if os.path.isdir("/proc/self/fd") else "/dev/fd"
    path = f"{root}/{descriptor}"
    return f"{path}/{child}" if child else path


def atomic_json_at(directory_fd: int, name: str, value: object) -> None:
    temporary = f".{name}.next.{secrets.token_hex(12)}"
    descriptor: Optional[int] = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=directory_fd,
        )
        body = f"{json.dumps(value, indent=2)}\n".encode()
        view = memoryview(body)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                fail("database identity journal write was incomplete")
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.link(
            temporary,
            name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
            follow_symlinks=False,
        )
        fsync_directory_fd(directory_fd)
        os.unlink(temporary, dir_fd=directory_fd)
        fsync_directory_fd(directory_fd)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError:
            pass


def read_json_at(directory_fd: int, name: str) -> object:
    descriptor = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
    try:
        observed = os.fstat(descriptor)
        if (
            not stat.S_ISREG(observed.st_mode)
            or observed.st_nlink != 1
            or observed.st_size <= 0
            or observed.st_size > 128 * 1024
        ):
            fail("database identity journal is unsafe")
        with os.fdopen(os.dup(descriptor), "r", encoding="utf-8") as handle:
            return json.load(handle)
    finally:
        os.close(descriptor)


def open_database_context(
    database: str,
    transaction_directory: str,
) -> tuple[int, int, str]:
    database = canonical_absolute(database, "database")
    transaction_directory = canonical_absolute(
        transaction_directory,
        "database transaction directory",
    )
    parent_fd = open_absolute(os.path.dirname(database))
    transaction_fd = open_absolute(transaction_directory)
    transaction_stat = os.fstat(transaction_fd)
    if (
        not stat.S_ISDIR(transaction_stat.st_mode)
        or stat.S_IMODE(transaction_stat.st_mode) != 0o700
    ):
        os.close(parent_fd)
        os.close(transaction_fd)
        fail("database transaction directory is not private")
    return parent_fd, transaction_fd, os.path.basename(database)


def open_optional_regular_at(
    directory_fd: int,
    name: str,
    *,
    allow_empty: bool = False,
) -> Optional[int]:
    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
    except FileNotFoundError:
        return None
    observed = os.fstat(descriptor)
    if (
        not stat.S_ISREG(observed.st_mode)
        or observed.st_nlink != 1
        or (not allow_empty and observed.st_size <= 0)
        or observed.st_size > args_max_database_bytes()
    ):
        os.close(descriptor)
        fail("database path is not a bounded single-link regular file")
    return descriptor


def assert_no_database_handles(
    fuser: str,
    descriptors: list[int],
    *,
    test_mode: bool,
) -> None:
    for descriptor in descriptors:
        # Do not pass the database descriptor into fuser.  The helper itself
        # legitimately holds it to keep the pathname bound, so GNU fuser must
        # report the helper PID; inheriting the same FD into fuser would create
        # a second self-generated holder.  The explicit parent-PID procfs path
        # keeps the target descriptor-bound while making the allowlist exact.
        target = f"/proc/{os.getpid()}/fd/{descriptor}"
        if not test_mode and not os.path.exists(target):
            fail("descriptor-bound process handle inspection requires procfs")
        process = subprocess.Popen(
            [fuser, "--", target],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="strict",
            close_fds=True,
        )
        try:
            stdout, _stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            fail("staging database handle check timed out")
        if process.returncode not in (0, 1):
            fail("staging database handle check did not complete safely")
        if stdout and not re.fullmatch(r"[0-9\s]+", stdout):
            fail("staging database handle check returned malformed PID output")
        holders = {
            int(value)
            for value in stdout.split()
        }
        allowed = {os.getpid(), process.pid}
        if os.getpid() not in holders:
            fail("staging database handle check did not prove its bound target")
        if holders - allowed:
            fail("staging database still has an open process handle")
        if process.returncode != 0:
            fail("staging database handle check did not complete safely")


def assert_database_paths_bound(
    parent_fd: int,
    database_name: str,
    source_fd: Optional[int],
    sidecar_fds: dict[str, int],
) -> None:
    expected: dict[str, int] = {}
    if source_fd is not None:
        expected[database_name] = source_fd
    expected.update(sidecar_fds)
    for name in (database_name, f"{database_name}-wal", f"{database_name}-shm"):
        descriptor = expected.get(name)
        try:
            observed = os.stat(
                name,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            if descriptor is not None:
                fail("database path disappeared while it was descriptor-bound")
            continue
        if descriptor is None:
            fail("database sidecar appeared after the stopped-state check")
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(observed.st_mode)
            or observed.st_nlink != 1
            or observed.st_dev != opened.st_dev
            or observed.st_ino != opened.st_ino
        ):
            fail("database path changed while it was descriptor-bound")


def sqlite_integrity(file_path: str) -> None:
    connection = sqlite3.connect(
        f"file:{file_path}?mode=ro&immutable=1",
        uri=True,
        timeout=30,
    )
    try:
        row = connection.execute("PRAGMA integrity_check").fetchone()
        if row is None or row[0] != "ok":
            fail("SQLite integrity_check failed")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            fail("SQLite foreign_key_check failed")
    finally:
        connection.close()


def validate_database_identity(value: object) -> dict[str, object]:
    expected = {
        "createdAt",
        "gid",
        "mode",
        "parentDev",
        "parentIno",
        "schema",
        "sha256",
        "sizeBytes",
        "sourceDev",
        "sourceIno",
        "uid",
    }
    if (
        not isinstance(value, dict)
        or set(value) != expected
        or value.get("schema")
        != "nexus.rollback-drill-legacy-staging-database-backup.v1"
        or not isinstance(value.get("sha256"), str)
        or len(value["sha256"]) != 64
        or any(character not in "0123456789abcdef" for character in value["sha256"])
        or not isinstance(value.get("sizeBytes"), int)
        or value["sizeBytes"] <= 0
        or value["sizeBytes"] > args_max_database_bytes()
        or not isinstance(value.get("uid"), int)
        or not isinstance(value.get("gid"), int)
        or not isinstance(value.get("mode"), int)
        or value["mode"] < 0
        or value["mode"] > 0o7777
        or not isinstance(value.get("parentDev"), str)
        or not value["parentDev"].isdigit()
        or not isinstance(value.get("parentIno"), str)
        or not value["parentIno"].isdigit()
        or not isinstance(value.get("sourceDev"), str)
        or not value["sourceDev"].isdigit()
        or not isinstance(value.get("sourceIno"), str)
        or not value["sourceIno"].isdigit()
        or not isinstance(value.get("createdAt"), str)
    ):
        fail("database recovery-point identity is invalid")
    return value


def verify_backup_fd(
    backup_fd: int,
    expected: Optional[dict[str, object]] = None,
) -> tuple[str, int]:
    observed = os.fstat(backup_fd)
    if (
        not stat.S_ISREG(observed.st_mode)
        or observed.st_nlink != 1
        or stat.S_IMODE(observed.st_mode) != 0o600
    ):
        fail("database recovery point mode or type is unsafe")
    digest, size = digest_fd(backup_fd)
    sqlite_integrity(descriptor_path(backup_fd))
    if expected and (
        digest != expected["sha256"]
        or size != expected["sizeBytes"]
    ):
        fail("database recovery point identity mismatch")
    return digest, size


def command_snapshot_database(args: argparse.Namespace) -> None:
    parent_fd, transaction_fd, database_name = open_database_context(
        args.database,
        args.transaction_directory,
    )
    source_fd: Optional[int] = None
    backup_fd: Optional[int] = None
    sidecar_fds: dict[str, int] = {}
    temporary = f".rollback-database.next.{secrets.token_hex(12)}"
    destination_fd: Optional[int] = None
    try:
        source_fd = open_optional_regular_at(parent_fd, database_name)
        if source_fd is None:
            fail("staging database is unavailable")
        source_stat = os.fstat(source_fd)
        parent_stat = os.fstat(parent_fd)
        for suffix in ("-wal", "-shm"):
            descriptor = open_optional_regular_at(
                parent_fd,
                f"{database_name}{suffix}",
                allow_empty=True,
            )
            if descriptor is not None:
                sidecar_fds[f"{database_name}{suffix}"] = descriptor
        if ((f"{database_name}-wal" in sidecar_fds)
                != (f"{database_name}-shm" in sidecar_fds)):
            fail("stopped SQLite WAL sidecars are incomplete")
        assert_no_database_handles(
            args.fuser,
            [source_fd, *sidecar_fds.values()],
            test_mode=args.test_mode,
        )
        assert_database_paths_bound(
            parent_fd,
            database_name,
            source_fd,
            sidecar_fds,
        )
        pause_if_requested(args, "database")
        assert_database_paths_bound(
            parent_fd,
            database_name,
            source_fd,
            sidecar_fds,
        )
        reopened_parent = open_absolute(os.path.dirname(args.database))
        try:
            reopened = os.fstat(reopened_parent)
            if (
                reopened.st_dev != parent_stat.st_dev
                or reopened.st_ino != parent_stat.st_ino
            ):
                fail(
                    "database parent changed during its "
                    "descriptor-bound snapshot"
                )
        finally:
            os.close(reopened_parent)
        source_identity = {
            "schema": "nexus.rollback-drill-legacy-staging-database-source.v1",
            "uid": source_stat.st_uid,
            "gid": source_stat.st_gid,
            "mode": stat.S_IMODE(source_stat.st_mode),
            "parentDev": str(parent_stat.st_dev),
            "parentIno": str(parent_stat.st_ino),
            "sourceDev": str(source_stat.st_dev),
            "sourceIno": str(source_stat.st_ino),
        }
        try:
            stored_source = read_json_at(
                transaction_fd,
                "rollback-database-source.json",
            )
            if stored_source != source_identity:
                fail("database source identity changed after snapshot intent")
        except FileNotFoundError:
            atomic_json_at(
                transaction_fd,
                "rollback-database-source.json",
                source_identity,
            )

        try:
            identity_value = validate_database_identity(
                read_json_at(transaction_fd, "rollback-database.identity.json"),
            )
            backup_fd = open_optional_regular_at(
                transaction_fd,
                "rollback-database.db",
            )
            if backup_fd is None:
                fail("database identity exists without its recovery point")
            verify_backup_fd(backup_fd, identity_value)
            print(json.dumps({"databaseBackup": identity_value}))
            return
        except FileNotFoundError:
            pass

        try:
            os.stat(
                "rollback-database.db",
                dir_fd=transaction_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        else:
            # A crash may occur after the backup was published but before its
            # identity sidecar. Verify and finish that transaction.
            backup_fd = open_optional_regular_at(
                transaction_fd,
                "rollback-database.db",
            )
            if backup_fd is None:
                fail("database recovery point is unavailable")
            digest, size = verify_backup_fd(backup_fd)
            identity_value = {
                **source_identity,
                "schema":
                    "nexus.rollback-drill-legacy-staging-database-backup.v1",
                "sha256": digest,
                "sizeBytes": size,
                "createdAt": datetime.fromtimestamp(
                    os.fstat(backup_fd).st_mtime,
                    tz=timezone.utc,
                ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            }
            atomic_json_at(
                transaction_fd,
                "rollback-database.identity.json",
                identity_value,
            )
            print(json.dumps({"databaseBackup": identity_value}))
            return

        # Open through the pinned parent directory rather than through the
        # database file descriptor itself. SQLite derives -wal/-shm paths from
        # this URI, so a stopped but uncheckpointed WAL is included in the
        # backup. The exact database and sidecar inodes remain held and are
        # checked immediately before and after the backup.
        if os.path.isdir("/proc/self/fd"):
            source = descriptor_path(parent_fd, database_name)
        elif args.test_mode:
            # macOS SQLite cannot traverse a directory descriptor through
            # /dev/fd. Tests retain the inode descriptors and perform the same
            # before/after identity checks around the canonical fixture path.
            source = args.database
        else:
            fail("descriptor-bound SQLite source requires procfs")
        source_db = sqlite3.connect(
            f"file:{source}?mode=ro",
            uri=True,
            timeout=30,
        )
        if os.path.isdir("/proc/self/fd"):
            destination = descriptor_path(transaction_fd, temporary)
            destination_db = sqlite3.connect(destination)
            try:
                source_db.backup(destination_db, pages=1024, sleep=0.025)
                destination_db.commit()
            finally:
                destination_db.close()
                source_db.close()
        else:
            if not args.test_mode:
                fail("descriptor-bound SQLite destination requires procfs")
            # macOS test runners expose retained descriptors through /dev/fd
            # but SQLite will not create a database through that path. Keep
            # the source descriptor-bound and serialize the backed-up in-memory
            # database into an openat-created destination descriptor.
            destination_db = sqlite3.connect(":memory:")
            try:
                source_db.backup(destination_db, pages=1024, sleep=0.025)
                body = destination_db.serialize()
            finally:
                destination_db.close()
                source_db.close()
            destination_fd = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL
                | getattr(os, "O_CLOEXEC", 0),
                0o600,
                dir_fd=transaction_fd,
            )
            view = memoryview(body)
            while view:
                written = os.write(destination_fd, view)
                if written <= 0:
                    fail("database recovery point write was incomplete")
                view = view[written:]
            os.fsync(destination_fd)
            os.close(destination_fd)
            destination_fd = None
        temporary_fd = os.open(temporary, FILE_FLAGS, dir_fd=transaction_fd)
        try:
            os.fchmod(temporary_fd, 0o600)
            if not args.test_mode:
                os.fchown(temporary_fd, 0, 0)
            os.fsync(temporary_fd)
            digest, size = verify_backup_fd(temporary_fd)
            created_at = datetime.fromtimestamp(
                os.fstat(temporary_fd).st_mtime,
                tz=timezone.utc,
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        finally:
            os.close(temporary_fd)
        os.link(
            temporary,
            "rollback-database.db",
            src_dir_fd=transaction_fd,
            dst_dir_fd=transaction_fd,
            follow_symlinks=False,
        )
        fsync_directory_fd(transaction_fd)
        os.unlink(temporary, dir_fd=transaction_fd)
        fsync_directory_fd(transaction_fd)
        identity_value = {
            **source_identity,
            "schema": "nexus.rollback-drill-legacy-staging-database-backup.v1",
            "sha256": digest,
            "sizeBytes": size,
            "createdAt": created_at,
        }
        atomic_json_at(
            transaction_fd,
            "rollback-database.identity.json",
            identity_value,
        )
        reopened_parent = open_absolute(os.path.dirname(args.database))
        try:
            reopened = os.fstat(reopened_parent)
            if (
                reopened.st_dev != parent_stat.st_dev
                or reopened.st_ino != parent_stat.st_ino
            ):
                fail("database parent changed during its descriptor-bound snapshot")
        finally:
            os.close(reopened_parent)
        assert_no_database_handles(
            args.fuser,
            [source_fd, *sidecar_fds.values()],
            test_mode=args.test_mode,
        )
        assert_database_paths_bound(
            parent_fd,
            database_name,
            source_fd,
            sidecar_fds,
        )
        print(json.dumps({"databaseBackup": identity_value}))
    finally:
        if backup_fd is not None:
            os.close(backup_fd)
        if destination_fd is not None:
            os.close(destination_fd)
        if source_fd is not None:
            os.close(source_fd)
        for descriptor in sidecar_fds.values():
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=transaction_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)
        os.close(transaction_fd)


def command_restore_database(args: argparse.Namespace) -> None:
    expected = validate_database_identity(json.loads(args.database_identity))
    parent_fd, transaction_fd, database_name = open_database_context(
        args.database,
        args.transaction_directory,
    )
    backup_fd: Optional[int] = None
    source_fd: Optional[int] = None
    sidecar_fds: dict[str, int] = {}
    temporary = f".bot.db.legacy-drill-restore.{secrets.token_hex(12)}"
    temporary_fd: Optional[int] = None
    try:
        parent_stat = os.fstat(parent_fd)
        if (
            str(parent_stat.st_dev) != expected["parentDev"]
            or str(parent_stat.st_ino) != expected["parentIno"]
        ):
            fail("journaled database parent identity changed")
        backup_fd = open_optional_regular_at(
            transaction_fd,
            "rollback-database.db",
        )
        if backup_fd is None:
            fail("database recovery point is unavailable")
        verify_backup_fd(backup_fd, expected)
        source_fd = open_optional_regular_at(
            parent_fd,
            database_name,
            allow_empty=True,
        )
        for suffix in ("-wal", "-shm"):
            descriptor = open_optional_regular_at(
                parent_fd,
                f"{database_name}{suffix}",
                allow_empty=True,
            )
            if descriptor is not None:
                sidecar_fds[f"{database_name}{suffix}"] = descriptor
        if ((f"{database_name}-wal" in sidecar_fds)
                != (f"{database_name}-shm" in sidecar_fds)):
            fail("stopped SQLite WAL sidecars are incomplete")
        assert_no_database_handles(
            args.fuser,
            [
                *([] if source_fd is None else [source_fd]),
                *sidecar_fds.values(),
            ],
            test_mode=args.test_mode,
        )
        assert_database_paths_bound(
            parent_fd,
            database_name,
            source_fd,
            sidecar_fds,
        )
        pause_if_requested(args, "database")
        assert_database_paths_bound(
            parent_fd,
            database_name,
            source_fd,
            sidecar_fds,
        )
        reopened_parent = open_absolute(os.path.dirname(args.database))
        try:
            reopened = os.fstat(reopened_parent)
            if (
                reopened.st_dev != parent_stat.st_dev
                or reopened.st_ino != parent_stat.st_ino
            ):
                fail(
                    "database parent changed during "
                    "descriptor-bound restore"
                )
        finally:
            os.close(reopened_parent)
        temporary_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=parent_fd,
        )
        digest = hashlib.sha256()
        bytes_copied = 0
        os.lseek(backup_fd, 0, os.SEEK_SET)
        while True:
            block = os.read(backup_fd, 1024 * 1024)
            if not block:
                break
            digest.update(block)
            bytes_copied += len(block)
            if bytes_copied > args_max_database_bytes():
                fail("database recovery point exceeds its size bound")
            view = memoryview(block)
            while view:
                written = os.write(temporary_fd, view)
                if written <= 0:
                    fail("database restore write was incomplete")
                view = view[written:]
        if (
            bytes_copied != expected["sizeBytes"]
            or digest.hexdigest() != expected["sha256"]
        ):
            fail("database recovery point changed while it was copied")
        if not args.test_mode:
            os.fchown(temporary_fd, expected["uid"], expected["gid"])
        os.fchmod(temporary_fd, expected["mode"])
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None
        for suffix in ("-wal", "-shm"):
            name = f"{database_name}{suffix}"
            try:
                observed = os.stat(
                    name,
                    dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1:
                fail("database sidecar path changed before restore")
            os.unlink(name, dir_fd=parent_fd)
        os.replace(
            temporary,
            database_name,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
        )
        fsync_directory_fd(parent_fd)
        restored_fd = os.open(database_name, FILE_FLAGS, dir_fd=parent_fd)
        try:
            restored = os.fstat(restored_fd)
            restored_digest, restored_size = digest_fd(restored_fd)
            sqlite_integrity(descriptor_path(restored_fd))
            if (
                restored_digest != expected["sha256"]
                or restored_size != expected["sizeBytes"]
                or stat.S_IMODE(restored.st_mode) != expected["mode"]
                or (
                    not args.test_mode
                    and (
                        restored.st_uid != expected["uid"]
                        or restored.st_gid != expected["gid"]
                    )
                )
            ):
                fail("restored database identity mismatch")
        finally:
            os.close(restored_fd)
        reopened_parent = open_absolute(os.path.dirname(args.database))
        try:
            reopened = os.fstat(reopened_parent)
            if (
                reopened.st_dev != parent_stat.st_dev
                or reopened.st_ino != parent_stat.st_ino
            ):
                fail("database parent changed during descriptor-bound restore")
        finally:
            os.close(reopened_parent)
        print(json.dumps({
            "ok": True,
            "databaseBackupSha256": expected["sha256"],
            "databaseBackupSizeBytes": expected["sizeBytes"],
        }))
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        if backup_fd is not None:
            os.close(backup_fd)
        if source_fd is not None:
            os.close(source_fd)
        for descriptor in sidecar_fds.values():
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)
        os.close(transaction_fd)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("operation", choices=[
        "assert-parents",
        "prepare-release",
        "capture",
        "seal",
        "assert-runtime",
        "runtime-identity",
        "assert-sealed",
        "assert-no-writable-references",
        "restore-metadata",
        "guarded-exec",
        "selector-json",
        "current-identity",
        "switch-selector",
        "snapshot-database",
        "restore-database",
    ])
    value.add_argument("--base", required=True)
    value.add_argument("--runtime", default="")
    value.add_argument("--expected", default="")
    value.add_argument("--target", default="")
    value.add_argument("--expect-dev", default="")
    value.add_argument("--expect-ino", default="")
    value.add_argument("--target-dev", default="")
    value.add_argument("--target-ino", default="")
    value.add_argument("--worker-uid", type=int, default=-1)
    value.add_argument("--worker-gid", type=int, default=-1)
    value.add_argument("--output", default="")
    value.add_argument("--metadata", default="")
    value.add_argument("--test-mode", action="store_true")
    value.add_argument("--proc-root", default="/proc")
    value.add_argument("--seal-marker", default="")
    value.add_argument("--seal-resume", default="")
    value.add_argument("--exec-marker", default="")
    value.add_argument("--exec-resume", default="")
    value.add_argument("--switch-marker", default="")
    value.add_argument("--switch-resume", default="")
    value.add_argument("--database", default="")
    value.add_argument("--transaction-directory", default="")
    value.add_argument("--database-identity", default="")
    value.add_argument("--fuser", default="/usr/bin/fuser")
    value.add_argument("--database-marker", default="")
    value.add_argument("--database-resume", default="")
    value.add_argument("--pass-fd", action="append", type=int, default=[])
    return value


def main() -> None:
    arguments = sys.argv[1:]
    command: list[str] = []
    if "--" in arguments:
        separator = arguments.index("--")
        command = arguments[separator + 1:]
        arguments = arguments[:separator]
    args = parser().parse_args(arguments)
    args.command = command
    operations = {
        "assert-parents": command_assert_parents,
        "prepare-release": command_prepare_release,
        "capture": command_capture,
        "seal": command_seal,
        "assert-runtime": command_assert_runtime,
        "runtime-identity": command_runtime_identity,
        "assert-sealed": command_assert_sealed,
        "assert-no-writable-references":
            command_assert_no_writable_references,
        "restore-metadata": command_restore_metadata,
        "guarded-exec": command_guarded_exec,
        "selector-json": command_selector_json,
        "current-identity": command_current_identity,
        "switch-selector": command_switch_selector,
        "snapshot-database": command_snapshot_database,
        "restore-database": command_restore_database,
    }
    operations[args.operation](args)


if __name__ == "__main__":
    main()
