#!/usr/bin/env python3
"""Root-only atomic Nexus release selector switch.

All production, staging, and one-time layout selector mutations pass through
this helper.  The base directory is opened once and every selector operation
uses that pinned directory descriptor, so an unprivileged process cannot
redirect the final rename through a path race.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import stat
import sys
from pathlib import Path


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def is_beneath(runtime: str, base: str) -> bool:
    releases = os.path.join(base, "releases")
    return os.path.dirname(runtime) == releases and os.path.basename(runtime) not in ("", ".", "..")


def validate_directory(
    entry: str,
    *,
    uid: int,
    gid: int,
    mode: int,
    label: str,
) -> os.stat_result:
    observed = os.lstat(entry)
    if (
        not stat.S_ISDIR(observed.st_mode)
        or stat.S_ISLNK(observed.st_mode)
        or os.path.realpath(entry) != entry
        or observed.st_uid != uid
        or observed.st_gid != gid
        or stat.S_IMODE(observed.st_mode) != mode
    ):
        fail(f"{label} ownership, mode, or canonical identity is unsafe")
    return observed


def runtime_allowed(runtime: str, base: str, legacy_base: str, layout: bool) -> bool:
    return is_beneath(runtime, base) or (layout and is_beneath(runtime, legacy_base))


def validate_runtime_if_present(
    runtime: str,
    *,
    root_uid: int,
    worker_gid: int,
    allow_missing: bool,
) -> bool:
    try:
        validate_directory(
            runtime,
            uid=root_uid,
            gid=worker_gid,
            mode=0o550,
            label="release runtime",
        )
        return True
    except FileNotFoundError:
        if allow_missing:
            return False
        raise


def read_selector(
    base_fd: int,
    *,
    root_uid: int,
    root_gid: int,
    worker_uid: int,
    worker_gid: int,
    adopt_owner: bool,
) -> tuple[os.stat_result, str]:
    observed = os.stat("current", dir_fd=base_fd, follow_symlinks=False)
    if not stat.S_ISLNK(observed.st_mode):
        fail("release current selector is not a symlink")
    safe_owner = observed.st_uid == root_uid and observed.st_gid == root_gid
    adoptable_owner = (
        adopt_owner
        and observed.st_uid in (root_uid, worker_uid)
        and observed.st_gid in (root_gid, worker_gid)
    )
    if not safe_owner and not adoptable_owner:
        fail("release current selector ownership is unsafe")
    target = os.readlink("current", dir_fd=base_fd)
    if not os.path.isabs(target):
        fail("release current selector target must be absolute")
    if not safe_owner:
        os.chown(
            "current",
            root_uid,
            root_gid,
            dir_fd=base_fd,
            follow_symlinks=False,
        )
        observed = os.stat("current", dir_fd=base_fd, follow_symlinks=False)
    return observed, target


def selector_identity(base: str, base_fd: int, target: str) -> dict[str, object]:
    observed = os.stat("current", dir_fd=base_fd, follow_symlinks=False)
    return {
        "schema": "nexus.release-current-selector-identity.v1",
        "path": os.path.join(base, "current"),
        "target": target,
        "dev": str(observed.st_dev),
        "ino": str(observed.st_ino),
        "uid": observed.st_uid,
        "gid": observed.st_gid,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("switch", "verify"))
    parser.add_argument("--role", choices=("production", "staging"), required=True)
    parser.add_argument("--expected")
    parser.add_argument("--target", required=True)
    parser.add_argument("--release-root", default="/srv/nexus-release")
    parser.add_argument("--worker-uid", type=int, required=True)
    parser.add_argument("--worker-gid", type=int, required=True)
    parser.add_argument("--legacy-base")
    parser.add_argument("--layout-transition", action="store_true")
    parser.add_argument(
        "--layout-base",
        choices=("authoritative", "legacy"),
        default="authoritative",
    )
    parser.add_argument("--adopt-existing-selector", action="store_true")
    parser.add_argument("--allow-test-owner", action="store_true")
    args = parser.parse_args()

    test_mode = (
        args.allow_test_owner
        and os.environ.get("NEXUS_RELEASE_TEST_MODE") == "1"
    )
    if os.geteuid() != 0 and not test_mode:
        fail("release selector switch requires root")

    release_root = os.path.abspath(args.release_root)
    authoritative_base = os.path.join(release_root, args.role)
    target = os.path.abspath(args.target)
    expected = os.path.abspath(args.expected) if args.expected else ""
    canonical_legacy = (
        "/home/dominguez/telegram-hub-bot"
        if args.role == "production"
        else "/home/dominguez/telegram-hub-bot-staging"
    )
    legacy_base = os.path.abspath(args.legacy_base or canonical_legacy)
    base = (
        legacy_base
        if args.layout_transition and args.layout_base == "legacy"
        else authoritative_base
    )
    if not test_mode:
        if release_root != "/srv/nexus-release":
            fail("release selector root is not the authoritative /srv layout")
        if legacy_base != canonical_legacy:
            fail("release selector legacy base is not authoritative")
    if args.layout_transition and not args.legacy_base:
        legacy_base = canonical_legacy
    if args.command == "switch" and not expected:
        fail("--expected is required for selector switch")
    if not (
        is_beneath(target, base)
        or (
            args.layout_transition
            and (
                is_beneath(target, authoritative_base)
                or is_beneath(target, legacy_base)
            )
        )
    ):
        fail("release selector target is outside the authorized releases roots")
    if expected and not (
        is_beneath(expected, base)
        or (
            args.layout_transition
            and (
                is_beneath(expected, authoritative_base)
                or is_beneath(expected, legacy_base)
            )
        )
    ):
        fail("release selector expected target is outside the authorized releases roots")

    root_uid = os.getuid() if test_mode else 0
    root_gid = os.getgid() if test_mode else 0
    validate_directory(
        release_root,
        uid=root_uid,
        gid=root_gid,
        mode=0o755,
        label="release root",
    )
    base_stat = validate_directory(
        base,
        uid=root_uid,
        gid=args.worker_gid,
        mode=0o1770,
        label="release base",
    )
    validate_directory(
        os.path.join(base, "releases"),
        uid=root_uid,
        gid=args.worker_gid,
        mode=0o750,
        label="release directory",
    )
    target_exists = validate_runtime_if_present(
        target,
        root_uid=root_uid,
        worker_gid=args.worker_gid,
        allow_missing=False,
    )
    expected_exists = False
    if expected:
        expected_exists = validate_runtime_if_present(
            expected,
            root_uid=root_uid,
            worker_gid=args.worker_gid,
            allow_missing=args.layout_transition,
        )
    if args.command == "verify" and not target_exists:
        fail("verified release selector target does not exist")

    open_flags = os.O_RDONLY | os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        open_flags |= os.O_NOFOLLOW
    base_fd = os.open(base, open_flags)
    temporary = ""
    try:
        pinned = os.fstat(base_fd)
        if (pinned.st_dev, pinned.st_ino) != (base_stat.st_dev, base_stat.st_ino):
            fail("release base changed before selector operation")
        _, observed_target = read_selector(
            base_fd,
            root_uid=root_uid,
            root_gid=root_gid,
            worker_uid=args.worker_uid,
            worker_gid=args.worker_gid,
            adopt_owner=args.adopt_existing_selector,
        )

        if args.command == "verify":
            if observed_target != target or os.path.realpath(
                os.path.join(base, "current")
            ) != target:
                fail("release selector does not identify the exact target")
            identity = selector_identity(base, base_fd, target)
            print(json.dumps(identity, separators=(",", ":")))
            return 0

        target_resolves = os.path.realpath(os.path.join(base, "current")) == target
        if observed_target == target and target_resolves:
            identity = selector_identity(base, base_fd, target)
            print(json.dumps({**identity, "idempotent": True}, separators=(",", ":")))
            return 0
        if observed_target != expected:
            fail("release selector compare-and-swap expectation failed")
        if expected_exists and os.path.realpath(os.path.join(base, "current")) != expected:
            fail("release selector resolved expectation failed")

        for _ in range(32):
            temporary = f".current.next.{secrets.token_hex(16)}"
            try:
                os.symlink(target, temporary, dir_fd=base_fd)
                break
            except FileExistsError:
                temporary = ""
        if not temporary:
            fail("could not allocate a unique release selector entry")
        staged = os.stat(temporary, dir_fd=base_fd, follow_symlinks=False)
        if (
            not stat.S_ISLNK(staged.st_mode)
            or staged.st_uid != root_uid
            or staged.st_gid != root_gid
            or os.readlink(temporary, dir_fd=base_fd) != target
        ):
            fail("staged release selector identity is unsafe")

        # Recheck the expected selector immediately before the single atomic
        # mutation. No unlink gap exists: current is always old or new.
        _, rechecked_target = read_selector(
            base_fd,
            root_uid=root_uid,
            root_gid=root_gid,
            worker_uid=args.worker_uid,
            worker_gid=args.worker_gid,
            adopt_owner=False,
        )
        if rechecked_target != expected:
            fail("release selector changed before atomic rename")
        if expected_exists and os.path.realpath(os.path.join(base, "current")) != expected:
            fail("release selector resolved target changed before atomic rename")
        os.rename(
            temporary,
            "current",
            src_dir_fd=base_fd,
            dst_dir_fd=base_fd,
        )
        temporary = ""
        os.fsync(base_fd)

        _, final_target = read_selector(
            base_fd,
            root_uid=root_uid,
            root_gid=root_gid,
            worker_uid=args.worker_uid,
            worker_gid=args.worker_gid,
            adopt_owner=False,
        )
        if final_target != target:
            fail("release selector final target is inconsistent")
        if target_exists and os.path.realpath(os.path.join(base, "current")) != target:
            fail("release selector final resolved target is inconsistent")
        identity = selector_identity(base, base_fd, target)
        print(json.dumps({**identity, "idempotent": False}, separators=(",", ":")))
        return 0
    finally:
        if temporary:
            try:
                os.unlink(temporary, dir_fd=base_fd)
                os.fsync(base_fd)
            except FileNotFoundError:
                pass
        os.close(base_fd)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"release selector switch: {error}", file=sys.stderr)
        raise SystemExit(1)
