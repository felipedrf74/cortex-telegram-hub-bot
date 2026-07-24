#!/usr/bin/env python3
"""Publish and validate the root-owned minimal PM2 resurrection authority."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import stat
import sys
from datetime import datetime, timezone
from typing import NoReturn

MAX_DUMP_BYTES = 1024 * 1024
MAX_METADATA_BYTES = 256 * 1024
POLICY_ENVIRONMENT_NAMES = (
    "OLLAMA_ENABLED",
    "AI_CLASSIFY_PRIMARY",
    "LOCAL_LLM_CLASSIFY_SHADOW",
    "CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE",
    "LOCAL_LLM_EVALUATION_MODE",
    "AI_SCRIPT_GENERATION_REQUIRE_LOCAL",
    "AI_SCRIPT_GENERATION_FALLBACK",
    "AI_LOCAL_REASONING_FALLBACK",
    "CLOUD_REASONING_FALLBACK_ENABLED",
    "CLOUD_REASONING_REQUIRE_APPROVED_MODEL",
    "CLOUD_REASONING_ON_UNAPPROVED_MODEL",
    "CLOUD_REASONING_PRIVACY_MODE",
    "CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA",
    "CLOUD_REASONING_PROVIDER",
    "CLOUD_REASONING_MODEL",
    "APPROVED_REASONING_MODELS",
    "OLLAMA_MODEL",
    "OLLAMA_CLASSIFIER_MODEL",
    "CHAT_CORE_V2_LOCAL_CHAT_MODEL",
    "CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL",
    "CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL",
)
FORBIDDEN_ENVIRONMENT_NAMES = {
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONINSPECT",
    "PYTHONSTARTUP",
    "PYTHONBREAKPOINT",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
}


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def safe_read(
    file: str,
    *,
    uid: int,
    gid: int,
    allowed_modes: set[int],
    maximum: int,
) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(file, flags)
    try:
        before = os.fstat(descriptor)
        if before.st_size < 1 or before.st_size > maximum:
            fail("PM2 dump authority input exceeds its bound")
        body = bytearray()
        while len(body) < before.st_size:
            chunk = os.read(descriptor, min(65536, before.st_size - len(body)))
            if not chunk:
                fail("PM2 dump authority input ended early")
            body.extend(chunk)
        after = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_uid != uid
            or before.st_gid != gid
            or stat.S_IMODE(before.st_mode) not in allowed_modes
            or len(body) != before.st_size
            or (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            )
        ):
            fail("PM2 dump authority input changed or has unsafe identity")
        return bytes(body)
    finally:
        os.close(descriptor)


def atomic_write(
    destination: str,
    body: bytes,
    *,
    uid: int,
    gid: int,
    mode: int,
) -> None:
    parent = os.path.dirname(destination)
    if os.path.realpath(parent) != parent:
        fail("PM2 dump authority parent is not canonical")
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
    directory = os.open(parent, directory_flags)
    temporary = ""
    try:
        parent_stat = os.fstat(directory)
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or parent_stat.st_uid != uid
            or stat.S_IMODE(parent_stat.st_mode) & 0o022
        ):
            fail("PM2 dump authority parent is unsafe")
        for _ in range(32):
            temporary = f".{os.path.basename(destination)}.next.{secrets.token_hex(16)}"
            try:
                descriptor = os.open(
                    temporary,
                    os.O_WRONLY
                    | os.O_CREAT
                    | os.O_EXCL
                    | getattr(os, "O_NOFOLLOW", 0),
                    mode,
                    dir_fd=directory,
                )
                break
            except FileExistsError:
                temporary = ""
        if not temporary:
            fail("could not allocate PM2 dump authority staging file")
        try:
            offset = 0
            while offset < len(body):
                offset += os.write(descriptor, body[offset:])
            os.fchown(descriptor, uid, gid)
            os.fchmod(descriptor, mode)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.rename(
            temporary,
            os.path.basename(destination),
            src_dir_fd=directory,
            dst_dir_fd=directory,
        )
        temporary = ""
        os.fsync(directory)
    finally:
        if temporary:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
        os.close(directory)


def expected_environment(
    *,
    role: str,
    base: str,
    runtime: str,
    runtime_sha: str,
    worker_home: str,
    pm2_home: str,
    backend: bool,
) -> tuple[set[str], dict[str, str]]:
    staging = role == "staging"
    backend_port = "8201" if staging else "8200"
    content_port = "8101" if staging else "8100"
    common = {
        "HOME": worker_home,
        "PM2_HOME": pm2_home,
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NEXUS_RELEASE_DIR": runtime,
        "NEXUS_RELEASE_BASE_DIR": base,
        "NEXUS_RELEASE_ROLE": role,
        "NEXUS_RELEASE_SHA": runtime_sha,
        "SENTRY_RELEASE": runtime_sha,
        "GIT_COMMIT": runtime_sha,
        "CONTENT_ENGINE_PORT": content_port,
        "NEXUS_BACKEND_BASE_URL": f"http://127.0.0.1:{backend_port}",
        "NEXUS_BACKEND_PORT": backend_port,
    }
    if backend:
        common.update(
            {
                "NODE_ENV": role,
                "STAGING": "true" if staging else "false",
                "PORTAL_PORT": backend_port,
                "DATABASE_PATH": f"{base}/data/bot.db",
            }
        )
        return set(common) | set(POLICY_ENVIRONMENT_NAMES), common
    common.update({"ENV": role, "PYTHONDONTWRITEBYTECODE": "1"})
    return set(common), common


def expected_services(args: argparse.Namespace) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for role, base, runtime, runtime_sha in (
        (
            "production",
            args.production_base,
            args.production_runtime,
            args.production_sha,
        ),
        (
            "staging",
            args.staging_base,
            args.staging_runtime,
            args.staging_sha,
        ),
    ):
        staging = role == "staging"
        backend_name = "nexus-hub-staging" if staging else "nexus-hub"
        content_name = "content-engine-staging" if staging else "content-engine"
        result.extend(
            [
                {
                    "name": backend_name,
                    "namespace": "default",
                    "pm_exec_path": f"{runtime}/dist/index.js",
                    "pm_cwd": runtime,
                    "exec_interpreter": "node",
                    "exec_mode": "fork_mode",
                    "autorestart": True,
                    "autostart": True,
                    "watch": False,
                    "max_memory_restart": 1024**3,
                    "pm_out_log_path": f"{base}/logs/out.log",
                    "pm_err_log_path": f"{base}/logs/error.log",
                    "pm_pid_path": f"{args.pm2_home}/pids/{backend_name}.pid",
                    "merge_logs": True,
                    "status": "online",
                    "vizion": False,
                    "windowsHide": True,
                    "node_args": ["--max-old-space-size=768"],
                    "exp_backoff_restart_delay": 5000,
                    "max_restarts": 15,
                    "min_uptime": 60000,
                    "restart_delay": 10000,
                    "kill_timeout": 10000,
                    "listen_timeout": 60000,
                    "_environment": expected_environment(
                        role=role,
                        base=base,
                        runtime=runtime,
                        runtime_sha=runtime_sha,
                        worker_home=args.worker_home,
                        pm2_home=args.pm2_home,
                        backend=True,
                    ),
                },
                {
                    "name": content_name,
                    "namespace": "default",
                    "pm_exec_path": (
                        f"{runtime}/content-engine/.venv/bin/python3.12"
                    ),
                    "pm_cwd": f"{runtime}/content-engine",
                    "exec_interpreter": "none",
                    "exec_mode": "fork_mode",
                    "autorestart": True,
                    "autostart": True,
                    "watch": False,
                    "max_memory_restart": (300 if staging else 500) * 1024**2,
                    "pm_out_log_path": f"{base}/logs/content-engine-out.log",
                    "pm_err_log_path": f"{base}/logs/content-engine-error.log",
                    "pm_pid_path": f"{args.pm2_home}/pids/{content_name}.pid",
                    "merge_logs": True,
                    "status": "online",
                    "vizion": False,
                    "windowsHide": True,
                    "node_args": [],
                    "args": ["main.py"],
                    "restart_delay": 5000,
                    "kill_timeout": 5000,
                    "_environment": expected_environment(
                        role=role,
                        base=base,
                        runtime=runtime,
                        runtime_sha=runtime_sha,
                        worker_home=args.worker_home,
                        pm2_home=args.pm2_home,
                        backend=False,
                    ),
                },
            ]
        )
    return result


def validate_dump(body: bytes, args: argparse.Namespace) -> None:
    try:
        rows = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("PM2 dump is not valid JSON") from error
    expected = expected_services(args)
    if not isinstance(rows, list) or len(rows) != len(expected):
        fail("PM2 dump must contain exactly four release services")
    expected_names = sorted(str(item["name"]) for item in expected)
    actual_names = sorted(
        row.get("name") if isinstance(row, dict) else "" for row in rows
    )
    if actual_names != expected_names:
        fail("PM2 dump service name multiset is not exact")
    for expected_row in expected:
        environment_keys, exact_environment = expected_row.pop("_environment")
        matches = [
            row
            for row in rows
            if isinstance(row, dict) and row.get("name") == expected_row["name"]
        ]
        if len(matches) != 1:
            fail(f"PM2 dump service identity is not unique: {expected_row['name']}")
        row = matches[0]
        if set(row) != set(expected_row) | {"env"}:
            fail(f"PM2 dump contains unapproved fields: {expected_row['name']}")
        for field, expected_value in expected_row.items():
            if row.get(field) != expected_value:
                fail(
                    f"PM2 dump launch field differs: "
                    f"{expected_row['name']}.{field}"
                )
        environment = row.get("env")
        if not isinstance(environment, dict) or set(environment) != environment_keys:
            fail(f"PM2 dump environment is not exact: {expected_row['name']}")
        if any(
            name in FORBIDDEN_ENVIRONMENT_NAMES
            or not isinstance(value, str)
            or len(value) > 2048
            or "\0" in value
            for name, value in environment.items()
        ):
            fail(f"PM2 dump environment is unsafe: {expected_row['name']}")
        for name, value in exact_environment.items():
            if environment.get(name) != value:
                fail(
                    f"PM2 dump environment differs: "
                    f"{expected_row['name']}.{name}"
                )
        if expected_row["name"].startswith("nexus-hub"):
            for name in POLICY_ENVIRONMENT_NAMES:
                value = environment.get(name)
                if (
                    not isinstance(value, str)
                    or not value
                    or len(value) > 512
                    or any(ord(character) < 32 or ord(character) == 127 for character in value)
                ):
                    fail(
                        f"PM2 dump policy environment is invalid: "
                        f"{expected_row['name']}.{name}"
                    )


def validate_metadata(
    body: bytes,
    digest: str,
    args: argparse.Namespace,
) -> dict[str, object]:
    value = json.loads(body)
    expected_roles = {
        "production": {
            "base": args.production_base,
            "runtime": args.production_runtime,
            "runtimeSha": args.production_sha,
        },
        "staging": {
            "base": args.staging_base,
            "runtime": args.staging_runtime,
            "runtimeSha": args.staging_sha,
        },
    }
    if (
        value.get("schema") != "nexus.pm2-authority-capture.v1"
        or value.get("canonicalDumpSha256") != digest
        or not isinstance(value.get("daemon", {}).get("pid"), int)
        or value["daemon"]["pid"] < 1
        or value.get("pm2", {}).get("version") != "6.0.14"
        or not isinstance(value.get("pm2", {}).get("closureRoot"), str)
        or not isinstance(value.get("pm2", {}).get("nodePath"), str)
    ):
        fail("PM2 authority capture metadata is invalid")
    for digest_value in (
        value.get("rawDumpSha256"),
        value.get("pm2", {}).get("closureDigest"),
        value.get("pm2", {}).get("nodeSha256"),
    ):
        if (
            not isinstance(digest_value, str)
            or len(digest_value) != 64
            or any(character not in "0123456789abcdef" for character in digest_value)
        ):
            fail("PM2 authority capture digest is invalid")
    roles = value.get("roles")
    if not isinstance(roles, dict) or set(roles) != set(expected_roles):
        fail("PM2 authority capture roles are not exact")
    for role, identity in expected_roles.items():
        observed = roles.get(role)
        if not isinstance(observed, dict):
            fail("PM2 authority capture role is invalid")
        for field, expected_value in identity.items():
            if observed.get(field) != expected_value:
                fail("PM2 authority capture release identity differs")
        for field in ("configSha256", "environmentSha256"):
            digest_value = observed.get(field)
            if (
                not isinstance(digest_value, str)
                or len(digest_value) != 64
                or any(character not in "0123456789abcdef" for character in digest_value)
            ):
                fail("PM2 authority capture config digest is invalid")
    return value


def receipt_body(
    digest: str,
    metadata: dict[str, object],
    args: argparse.Namespace,
) -> bytes:
    value = {
        "schema": "nexus.pm2-resurrection-authority.v2",
        "dumpSha256": digest,
        "serviceCount": 4,
        "production": {
            "base": args.production_base,
            "runtime": args.production_runtime,
            "runtimeSha": args.production_sha,
            "configSha256": metadata["roles"]["production"]["configSha256"],
            "environmentSha256": metadata["roles"]["production"][
                "environmentSha256"
            ],
        },
        "staging": {
            "base": args.staging_base,
            "runtime": args.staging_runtime,
            "runtimeSha": args.staging_sha,
            "configSha256": metadata["roles"]["staging"]["configSha256"],
            "environmentSha256": metadata["roles"]["staging"][
                "environmentSha256"
            ],
        },
        "pm2": metadata["pm2"],
        "capture": {
            "rawDumpSha256": metadata["rawDumpSha256"],
            "daemon": metadata["daemon"],
            "capturedAt": metadata.get("capturedAt"),
        },
        "publishedAt": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
    }
    return f"{json.dumps(value, indent=2)}\n".encode()


def validate_receipt(
    body: bytes,
    digest: str,
    args: argparse.Namespace,
) -> dict[str, object]:
    value = json.loads(body)
    if (
        value.get("schema") != "nexus.pm2-resurrection-authority.v2"
        or value.get("dumpSha256") != digest
        or value.get("serviceCount") != 4
    ):
        fail("PM2 dump receipt does not match its canonical dump")
    for role, base, runtime, runtime_sha in (
        (
            "production",
            args.production_base,
            args.production_runtime,
            args.production_sha,
        ),
        ("staging", args.staging_base, args.staging_runtime, args.staging_sha),
    ):
        identity = value.get(role)
        if (
            not isinstance(identity, dict)
            or identity.get("base") != base
            or identity.get("runtime") != runtime
            or identity.get("runtimeSha") != runtime_sha
        ):
            fail("PM2 dump receipt does not match exact release identities")
        for field in ("configSha256", "environmentSha256"):
            digest_value = identity.get(field)
            if (
                not isinstance(digest_value, str)
                or len(digest_value) != 64
                or any(character not in "0123456789abcdef" for character in digest_value)
            ):
                fail("PM2 dump receipt config digest is invalid")
    pm2 = value.get("pm2")
    if (
        not isinstance(pm2, dict)
        or pm2.get("version") != "6.0.14"
        or not isinstance(pm2.get("closureRoot"), str)
        or not isinstance(pm2.get("nodePath"), str)
    ):
        fail("PM2 dump receipt closure identity is invalid")
    for digest_value in (pm2.get("closureDigest"), pm2.get("nodeSha256")):
        if (
            not isinstance(digest_value, str)
            or len(digest_value) != 64
            or any(character not in "0123456789abcdef" for character in digest_value)
        ):
            fail("PM2 dump receipt closure digest is invalid")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("publish", "validate"))
    parser.add_argument("--source")
    parser.add_argument("--metadata")
    parser.add_argument("--canonical", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--production-base", required=True)
    parser.add_argument("--production-runtime", required=True)
    parser.add_argument("--production-sha", required=True)
    parser.add_argument("--staging-base", required=True)
    parser.add_argument("--staging-runtime", required=True)
    parser.add_argument("--staging-sha", required=True)
    parser.add_argument("--worker-home", required=True)
    parser.add_argument("--pm2-home", required=True)
    parser.add_argument("--worker-uid", type=int, required=True)
    parser.add_argument("--worker-gid", type=int, required=True)
    parser.add_argument("--allow-test-owner", action="store_true")
    args = parser.parse_args()
    test_mode = (
        args.allow_test_owner
        and os.environ.get("NEXUS_RELEASE_TEST_MODE") == "1"
    )
    if os.geteuid() != 0 and not test_mode:
        fail("PM2 dump authority requires root")
    root_uid = os.getuid() if test_mode else 0
    root_gid = os.getgid() if test_mode else 0
    for sha in (args.production_sha, args.staging_sha):
        if len(sha) != 40 or any(
            character not in "0123456789abcdef" for character in sha
        ):
            fail("PM2 dump authority runtime SHA is invalid")
    for base, runtime in (
        (args.production_base, args.production_runtime),
        (args.staging_base, args.staging_runtime),
    ):
        if os.path.dirname(runtime) != f"{base}/releases":
            fail("PM2 dump authority runtime is not a direct release child")

    if args.command == "publish":
        if not args.source or not args.metadata:
            fail("--source and --metadata are required for publication")
        source = safe_read(
            args.source,
            uid=root_uid,
            gid=root_gid,
            allowed_modes={0o600},
            maximum=MAX_DUMP_BYTES,
        )
        validate_dump(source, args)
        digest = hashlib.sha256(source).hexdigest()
        metadata_body = safe_read(
            args.metadata,
            uid=root_uid,
            gid=root_gid,
            allowed_modes={0o600},
            maximum=MAX_METADATA_BYTES,
        )
        metadata = validate_metadata(metadata_body, digest, args)
        atomic_write(
            args.canonical,
            source,
            uid=root_uid,
            gid=args.worker_gid,
            mode=0o440,
        )
        atomic_write(
            args.receipt,
            receipt_body(digest, metadata, args),
            uid=root_uid,
            gid=root_gid,
            mode=0o600,
        )
    canonical_body = safe_read(
        args.canonical,
        uid=root_uid,
        gid=args.worker_gid,
        allowed_modes={0o440},
        maximum=MAX_DUMP_BYTES,
    )
    validate_dump(canonical_body, args)
    digest = hashlib.sha256(canonical_body).hexdigest()
    receipt_body_value = safe_read(
        args.receipt,
        uid=root_uid,
        gid=root_gid,
        allowed_modes={0o600},
        maximum=MAX_METADATA_BYTES,
    )
    receipt = validate_receipt(receipt_body_value, digest, args)
    print(
        json.dumps(
            {
                "ok": True,
                "schema": receipt["schema"],
                "dumpSha256": digest,
                "serviceCount": 4,
                "pm2ClosureDigest": receipt["pm2"]["closureDigest"],
                "nodeSha256": receipt["pm2"]["nodeSha256"],
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"PM2 dump authority: {error}", file=sys.stderr)
        raise SystemExit(1)
