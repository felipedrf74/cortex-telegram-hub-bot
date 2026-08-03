#!/usr/bin/env python3
"""Create private directory trees without following or chmodding symlinks."""

from __future__ import annotations

import argparse
import hashlib
import os
import secrets
import stat
import sys


PRIVATE_MODE = 0o700
NOFOLLOW = os.O_NOFOLLOW


def die(message: str) -> None:
    raise RuntimeError(message)


def components(absolute: str) -> list[str]:
    normalized = os.path.normpath(absolute)
    if not os.path.isabs(normalized):
        die("directory paths must be absolute")
    return [part for part in normalized.split(os.sep) if part]


def open_child(parent_fd: int, name: str) -> int:
    return os.open(
        name,
        os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW,
        dir_fd=parent_fd,
    )


def validate_directory(fd: int, *, private: bool, label: str) -> os.stat_result:
    observed = os.fstat(fd)
    if not stat.S_ISDIR(observed.st_mode) or observed.st_uid != os.getuid():
        die(f"{label} must be an operator-owned ordinary directory")
    mode = stat.S_IMODE(observed.st_mode)
    if private and mode != PRIVATE_MODE:
        die(f"{label} must have exact mode 0700")
    if not private and mode & 0o022:
        die(f"{label} must not be group/world writable")
    return observed


def open_absolute_no_follow(absolute: str) -> tuple[int, list[tuple[int, int]]]:
    descriptor = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
    identities: list[tuple[int, int]] = []
    try:
        for component in components(absolute):
            child = open_child(descriptor, component)
            os.close(descriptor)
            descriptor = child
            observed = os.fstat(descriptor)
            identities.append((observed.st_dev, observed.st_ino))
        return descriptor, identities
    except BaseException:
        os.close(descriptor)
        raise


def ensure_target(anchor: str, target: str, exact_private: bool) -> None:
    anchor = os.path.normpath(anchor)
    target = os.path.normpath(target)
    if os.path.commonpath([anchor, target]) != anchor or target == anchor:
        die("private target must be a strict descendant of its anchor")

    anchor_fd, anchor_identity = open_absolute_no_follow(anchor)
    opened: list[tuple[str, tuple[int, int]]] = []
    try:
        validate_directory(anchor_fd, private=False, label="directory anchor")
        parent_fd = anchor_fd
        relative = os.path.relpath(target, anchor).split(os.sep)
        for index, component in enumerate(relative):
            is_leaf = index == len(relative) - 1
            try:
                child_fd = open_child(parent_fd, component)
            except FileNotFoundError:
                os.mkdir(component, PRIVATE_MODE, dir_fd=parent_fd)
                os.fsync(parent_fd)
                child_fd = open_child(parent_fd, component)
            observed = validate_directory(
                child_fd,
                private=exact_private or is_leaf,
                label=f"private directory component {component}",
            )
            opened.append((component, (observed.st_dev, observed.st_ino)))
            if parent_fd != anchor_fd:
                os.close(parent_fd)
            parent_fd = child_fd

        # Re-walk from the still-open anchor. Every pathname must continue to
        # name the exact directory inode used for the mutation.
        verify_fd = os.dup(anchor_fd)
        try:
            for component, expected_identity in opened:
                child_fd = open_child(verify_fd, component)
                os.close(verify_fd)
                verify_fd = child_fd
                observed = os.fstat(verify_fd)
                if (observed.st_dev, observed.st_ino) != expected_identity:
                    die("private directory path changed identity during creation")
        finally:
            os.close(verify_fd)
        if parent_fd != anchor_fd:
            os.close(parent_fd)
    finally:
        os.close(anchor_fd)
        # Confirm even the trusted anchor path did not get redirected.
        verify_anchor_fd, verify_identity = open_absolute_no_follow(anchor)
        try:
            if verify_identity != anchor_identity:
                die("directory anchor changed identity during creation")
        finally:
            os.close(verify_anchor_fd)


def open_parent_no_follow(filename: str) -> tuple[int, str]:
    absolute = os.path.normpath(filename)
    if not os.path.isabs(absolute) or os.path.basename(absolute) in {"", ".", ".."}:
        die("private file path must be normalized and absolute")
    parent_fd, _ = open_absolute_no_follow(os.path.dirname(absolute))
    return parent_fd, os.path.basename(absolute)


def read_private_source(filename: str) -> bytes:
    parent_fd, basename = open_parent_no_follow(filename)
    try:
        validate_directory(parent_fd, private=True, label="private source parent")
        descriptor = os.open(
            basename,
            os.O_RDONLY | NOFOLLOW,
            dir_fd=parent_fd,
        )
        try:
            observed = os.fstat(descriptor)
            if not stat.S_ISREG(observed.st_mode) or observed.st_uid != os.getuid() \
                    or stat.S_IMODE(observed.st_mode) != 0o600 or observed.st_nlink != 1:
                die("private replacement source must be one owner-only regular file")
            chunks: list[bytes] = []
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    return b"".join(chunks)
                chunks.append(chunk)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_fd)


def replace_private_file(source: str, destination: str) -> None:
    source_bytes = read_private_source(source)
    parent_fd, basename = open_parent_no_follow(destination)
    temporary = f".{basename}.replace-{os.getpid()}-{secrets.token_hex(6)}"
    descriptor: int | None = None
    try:
        validate_directory(parent_fd, private=True, label="private replacement parent")
        try:
            existing = os.stat(basename, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None and (
            not stat.S_ISREG(existing.st_mode)
            or existing.st_uid != os.getuid()
            or stat.S_IMODE(existing.st_mode) != 0o600
            or existing.st_nlink != 1
        ):
            die("private replacement destination is unsafe")
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
        offset = 0
        while offset < len(source_bytes):
            offset += os.write(descriptor, source_bytes[offset:])
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.rename(temporary, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
        published = os.open(
            basename,
            os.O_RDONLY | NOFOLLOW,
            dir_fd=parent_fd,
        )
        try:
            observed = os.fstat(published)
            digest = hashlib.sha256()
            while True:
                chunk = os.read(published, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            if not stat.S_ISREG(observed.st_mode) or observed.st_uid != os.getuid() \
                    or stat.S_IMODE(observed.st_mode) != 0o600 or observed.st_nlink != 1 \
                    or digest.digest() != hashlib.sha256(source_bytes).digest():
                die("private replacement did not publish exact durable bytes")
        finally:
            os.close(published)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--anchor")
    parser.add_argument("--exact-private", action="store_true")
    parser.add_argument("--replace-private-file", nargs=2, metavar=("SOURCE", "DESTINATION"))
    parser.add_argument("targets", nargs="*")
    args = parser.parse_args()
    if args.replace_private_file:
        if args.anchor or args.exact_private or args.targets:
            die("private replacement does not accept directory-creation arguments")
        replace_private_file(*args.replace_private_file)
        return
    if not args.anchor or not args.targets:
        die("directory creation requires --anchor and at least one target")
    for target in args.targets:
        ensure_target(args.anchor, target, args.exact_private)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"ensure-private-directory: {error}", file=sys.stderr)
        raise SystemExit(1) from error
