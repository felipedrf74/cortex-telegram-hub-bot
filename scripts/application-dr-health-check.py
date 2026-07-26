#!/usr/bin/env python3
"""Fail when the hourly application DR recovery point is stale or failed."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import types
from typing import Any, NoReturn


SCHEMA = "NexusApplicationDrHealthV1"
SUCCESS_SCHEMA = "nexus.application-dr-last-success.v1"
INSTALL_SCHEMA = "nexus.application-dr-install-transaction.v2"
SERVICE = re.compile(r"^nexus-application-dr-backup\.service$")
SYSTEMD_VALUE = re.compile(r"^[A-Za-z0-9_.:@-]{1,128}$")
INSTALL_PHASE = re.compile(r"^[a-z0-9-]{1,96}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
INSTALL_MAX_AGE_SECONDS = 15 * 60
INSTALL_KEYS = frozenset({
    "schema",
    "status",
    "phase",
    "startedAt",
    "updatedAt",
    "sourceRootSha256",
    "layoutSha256",
    "recoveryProgram",
    "recoveryProgramSha256",
    "transactionDirectory",
    "assets",
    "committedIndices",
    "recoveredIndices",
    "drillUser",
    "drillUserCreated",
    "healthTimerEnabledByInstall",
    "timerBefore",
})


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def parse_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(f"{label} is invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise SystemExit(f"{label} is invalid") from error
    if parsed.tzinfo is None:
        fail(f"{label} is invalid")
    return parsed.astimezone(timezone.utc)


def install_started_at(
    install_state: Any,
    *,
    state_dir: Path,
    owner_uid: int,
    now: datetime,
) -> datetime:
    if (
        not isinstance(install_state, dict)
        or set(install_state) != INSTALL_KEYS
        or install_state.get("schema") != INSTALL_SCHEMA
        or install_state.get("status") != "in_progress"
        or INSTALL_PHASE.fullmatch(str(install_state.get("phase", ""))) is None
        or not SHA256.fullmatch(str(install_state.get("sourceRootSha256", "")))
        or not SHA256.fullmatch(str(install_state.get("layoutSha256", "")))
        or not SHA256.fullmatch(
            str(install_state.get("recoveryProgramSha256", "")),
        )
        or install_state.get("recoveryProgram")
        != str(state_dir / "install-recovery-program.v2.py")
    ):
        fail("install journal shape is invalid")
    recovery_program = state_dir / "install-recovery-program.v2.py"
    recovery_body = trusted_file(
        recovery_program,
        owner_uid,
        "install recovery program",
    )
    if (
        hashlib.sha256(recovery_body).hexdigest()
        != install_state["recoveryProgramSha256"]
    ):
        fail("install recovery program differs from the journal binding")
    validator_module = types.ModuleType("nexus_application_dr_install_validator")
    validator_module.__file__ = str(recovery_program)
    try:
        exec(
            compile(recovery_body, str(recovery_program), "exec"),
            validator_module.__dict__,
        )
        if (
            getattr(validator_module, "SCHEMA", None) != INSTALL_SCHEMA
            or not callable(
                getattr(validator_module, "validate_journal_shape", None),
            )
        ):
            fail("install recovery program does not expose the exact validator")
        validator_module.validate_journal_shape(
            install_state,
            journal_path=state_dir / "install-in-progress.v1",
        )
    except SystemExit as error:
        fail(f"install journal shape is invalid: {error}")
    except Exception as error:
        fail(
            "install recovery program could not validate the retained journal: "
            f"{type(error).__name__}",
        )
    started_at = parse_timestamp(
        install_state["startedAt"],
        "install journal startedAt",
    )
    updated_at = parse_timestamp(
        install_state["updatedAt"],
        "install journal updatedAt",
    )
    if updated_at < started_at:
        fail("install journal update predates its start")
    if int((updated_at - now).total_seconds()) > 300:
        fail("install journal update is dated in the future")
    return started_at


def trusted_directory(path: Path, owner_uid: int, boundary: Path) -> None:
    try:
        metadata = path.lstat()
        canonical = path.resolve(strict=True)
        canonical_boundary = boundary.resolve(strict=True)
    except OSError as error:
        fail(f"state directory is unavailable: {error}")
    if (
        canonical != path
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != owner_uid
        or stat.S_IMODE(metadata.st_mode) & 0o077
    ):
        fail("state directory must be canonical and owner-private")
    try:
        path.relative_to(canonical_boundary)
    except ValueError:
        fail("state directory is outside the trusted boundary")


def trusted_file(path: Path, owner_uid: int, label: str) -> bytes:
    try:
        metadata = path.lstat()
        canonical = path.resolve(strict=True)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        canonical != path
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != owner_uid
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        fail(f"{label} must be a canonical owner-only regular file")
    try:
        body = path.read_bytes()
    except OSError as error:
        fail(f"{label} is unreadable: {error}")
    if len(body) > 64 * 1024:
        fail(f"{label} exceeds its size bound")
    return body


def trusted_executable(path: Path, owner_uid: int, boundary: Path, label: str) -> None:
    try:
        metadata = path.lstat()
        canonical = path.resolve(strict=True)
        canonical_boundary = boundary.resolve(strict=True)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        canonical != path
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != owner_uid
        or stat.S_IMODE(metadata.st_mode) & 0o022
        or stat.S_IMODE(metadata.st_mode) & 0o111 == 0
    ):
        fail(f"{label} is outside the executable trust boundary")
    try:
        path.relative_to(canonical_boundary)
    except ValueError:
        fail(f"{label} is outside the trusted boundary")


def systemd_state(systemctl: Path, service: str) -> dict[str, str]:
    try:
        result = subprocess.run(
            [
                str(systemctl),
                "show",
                service,
                "--property=ActiveState",
                "--property=SubState",
                "--property=Result",
            ],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        fail("systemd health query timed out")
    if (
        result.returncode != 0
        or len(result.stdout) > 16 * 1024
        or len(result.stderr) > 16 * 1024
    ):
        fail("systemd health query failed")
    values: dict[str, str] = {}
    try:
        lines = result.stdout.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise SystemExit("systemd health query was not UTF-8") from error
    for line in lines:
        key, separator, value = line.partition("=")
        if separator != "=" or key not in {"ActiveState", "SubState", "Result"}:
            fail("systemd health query returned an unexpected field")
        if key in values or SYSTEMD_VALUE.fullmatch(value) is None:
            fail("systemd health query returned an invalid value")
        values[key] = value
    if set(values) != {"ActiveState", "SubState", "Result"}:
        fail("systemd health query omitted a required field")
    return values


def atomic_replace(path: Path, payload: dict[str, Any], owner_uid: int) -> None:
    if path.parent.exists() is False:
        fail("health evidence parent is missing")
    if path.exists() or path.is_symlink():
        trusted_file(path, owner_uid, "existing health evidence")
    temporary = path.parent / f".{path.name}.tmp.{os.getpid()}"
    if temporary.exists() or temporary.is_symlink():
        fail("health evidence temporary path already exists")
    body = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        offset = 0
        while offset < len(body):
            written = os.write(descriptor, body[offset:])
            if written <= 0:
                fail("could not write complete health evidence")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def validated_alert_observation(
    payload: Any,
    *,
    unit: str,
) -> tuple[str, datetime, datetime]:
    if not isinstance(payload, dict):
        fail("active alert evidence is invalid")
    status = payload.get("status")
    expected_fields = {
        "schemaVersion",
        "status",
        "unit",
        "firstObservedAt",
        "lastObservedAt",
        "occurrences",
        "systemd",
        "operatorActionRequired",
    }
    if status == "resolved":
        expected_fields.add("resolvedAt")
    if (
        status not in {"active", "resolved"}
        or set(payload) != expected_fields
        or payload.get("schemaVersion") != "NexusApplicationDrAlertV1"
        or payload.get("unit") != unit
        or isinstance(payload.get("occurrences"), bool)
        or not isinstance(payload.get("occurrences"), int)
        or not 1 <= payload["occurrences"] <= 2_147_483_647
    ):
        fail("active alert evidence is invalid")
    systemd = payload.get("systemd")
    if (
        not isinstance(systemd, dict)
        or set(systemd) != {"activeState", "subState", "result"}
        or any(
            not isinstance(systemd.get(key), str)
            or SYSTEMD_VALUE.fullmatch(systemd[key]) is None
            for key in ("activeState", "subState", "result")
        )
    ):
        fail("active alert evidence is invalid")
    first_observed = parse_timestamp(
        payload.get("firstObservedAt"),
        "active alert firstObservedAt",
    )
    last_observed = parse_timestamp(
        payload.get("lastObservedAt"),
        "active alert lastObservedAt",
    )
    if last_observed < first_observed:
        fail("active alert observation interval is invalid")
    if status == "active":
        if payload.get("operatorActionRequired") is not True:
            fail("active alert evidence is invalid")
    else:
        if payload.get("operatorActionRequired") is not False:
            fail("active alert evidence is invalid")
        resolved_at = parse_timestamp(
            payload.get("resolvedAt"),
            "resolved alert resolvedAt",
        )
        if resolved_at < last_observed:
            fail("resolved alert interval is invalid")
    return status, first_observed, last_observed


def resolve_alert(
    path: Path,
    *,
    unit: str,
    now: datetime,
    last_success: datetime,
    owner_uid: int,
) -> None:
    if not path.exists() and not path.is_symlink():
        return
    body = trusted_file(path, owner_uid, "active alert evidence")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise SystemExit("active alert evidence is invalid") from error
    status, _, last_observed = validated_alert_observation(
        payload,
        unit=unit,
    )
    if status == "resolved":
        return
    # Both failure types require a recovery point newer than the most recent
    # occurrence, not merely newer than the first occurrence. A healthy check
    # against a point that predates a repeated failure must not clear it.
    if last_success <= last_observed:
        return
    payload["status"] = "resolved"
    payload["operatorActionRequired"] = False
    payload["resolvedAt"] = now.isoformat().replace("+00:00", "Z")
    atomic_replace(path, payload, owner_uid)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--service", default="nexus-application-dr-backup.service")
    parser.add_argument("--systemctl", required=True, type=Path)
    parser.add_argument("--max-age-seconds", type=int, default=3600)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-owner-uid", type=int, default=0)
    parser.add_argument("--trust-boundary", type=Path, default=Path("/"))
    parser.add_argument("--now")
    parser.add_argument("--test-mode", action="store_true")
    args = parser.parse_args()

    if os.geteuid() == 0 and args.test_mode:
        fail("test mode is forbidden for a privileged invocation")
    if not args.test_mode and os.geteuid() != 0:
        fail("production application DR health check must run as root")
    if args.expected_owner_uid != os.geteuid():
        fail("expected owner uid must equal the invoking uid")
    if SERVICE.fullmatch(args.service) is None:
        fail("backup service identity is invalid")
    if not 60 <= args.max_age_seconds <= 3600:
        fail("maximum recovery-point age is outside the fail-closed range")
    if args.now and not args.test_mode:
        fail("--now is available only in unprivileged test mode")
    trusted_directory(args.state_dir, args.expected_owner_uid, args.trust_boundary)
    trusted_executable(
        args.systemctl,
        args.expected_owner_uid,
        args.trust_boundary,
        "systemctl",
    )
    if args.output != args.state_dir / "health-current.v1.json":
        fail("health evidence path must use the exact state location")
    now = (
        parse_timestamp(args.now, "--now")
        if args.now
        else datetime.now(timezone.utc)
    )

    install_path = args.state_dir / "install-in-progress.v1"
    if install_path.exists() or install_path.is_symlink():
        install_body = trusted_file(
            install_path,
            args.expected_owner_uid,
            "install journal",
        )
        try:
            install_state = json.loads(install_body)
        except json.JSONDecodeError as error:
            raise SystemExit("install journal is invalid") from error
        install_started = install_started_at(
            install_state,
            state_dir=args.state_dir,
            owner_uid=args.expected_owner_uid,
            now=now,
        )
        install_age_seconds = int((now - install_started).total_seconds())
        if install_age_seconds < -300:
            fail("install journal is dated in the future")
        if install_age_seconds > INSTALL_MAX_AGE_SECONDS:
            fail("application DR installation has been incomplete for over 15 minutes")
        payload = {
            "schemaVersion": SCHEMA,
            "status": "installing",
            "observedAt": now.isoformat().replace("+00:00", "Z"),
            "installStartedAt": install_started.isoformat().replace("+00:00", "Z"),
            "installAgeSeconds": max(0, install_age_seconds),
            "maximumInstallAgeSeconds": INSTALL_MAX_AGE_SECONDS,
        }
        atomic_replace(args.output, payload, args.expected_owner_uid)
        print(
            json.dumps(
                {
                    "ok": True,
                    "schemaVersion": SCHEMA,
                    "status": "installing",
                    "installAgeSeconds": max(0, install_age_seconds),
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
        return

    success_path = args.state_dir / "last-success.v1.json"
    body = trusted_file(success_path, args.expected_owner_uid, "last-success evidence")
    try:
        success = json.loads(body)
    except json.JSONDecodeError as error:
        raise SystemExit("last-success evidence is invalid") from error
    if (
        not isinstance(success, dict)
        or set(success)
        != {
            "schema",
            "status",
            "startedAt",
            "completedAt",
            "storageProvider",
            "storageControlMode",
            "lifecyclePhase",
        }
        or success.get("schema") != SUCCESS_SCHEMA
        or success.get("status") != "passed"
        or (
            success.get("storageProvider"),
            success.get("storageControlMode"),
            success.get("lifecyclePhase"),
        )
        not in {
            ("aws-s3", "versioned-s3", "enabled"),
            (
                "cloudflare-r2",
                "r2-approved-variance",
                "approved-r2-variance",
            ),
        }
    ):
        fail("last-success evidence shape is invalid")
    started = parse_timestamp(success["startedAt"], "last-success startedAt")
    completed = parse_timestamp(success["completedAt"], "last-success completedAt")
    if completed < started or (completed - started).total_seconds() > 3600:
        fail("last-success evidence interval is invalid")
    age_seconds = int((now - completed).total_seconds())
    if age_seconds < -300:
        fail("last-success evidence is dated in the future")

    state = systemd_state(args.systemctl, args.service)
    if state["ActiveState"] == "failed" or state["Result"] != "success":
        fail("application DR backup service is failed")
    in_progress = state["ActiveState"] in {"active", "activating"}
    if age_seconds > args.max_age_seconds and not in_progress:
        fail("application DR recovery point is older than one hour")

    status = "in_progress" if age_seconds > args.max_age_seconds else "healthy"
    payload = {
        "schemaVersion": SCHEMA,
        "status": status,
        "observedAt": now.isoformat().replace("+00:00", "Z"),
        "lastSuccessAt": completed.isoformat().replace("+00:00", "Z"),
        "ageSeconds": max(0, age_seconds),
        "maximumAgeSeconds": args.max_age_seconds,
        "backupService": {
            "activeState": state["ActiveState"],
            "subState": state["SubState"],
            "result": state["Result"],
        },
    }
    atomic_replace(args.output, payload, args.expected_owner_uid)
    alerts = args.state_dir / "alerts"
    if alerts.exists():
        trusted_directory(alerts, args.expected_owner_uid, args.state_dir)
        for unit in (
            "nexus-application-dr-backup.service",
            "nexus-application-dr-health.service",
        ):
            resolve_alert(
                alerts / f"{unit}.v1.json",
                unit=unit,
                now=now,
                last_success=completed,
                owner_uid=args.expected_owner_uid,
            )
    print(
        json.dumps(
            {
                "ok": True,
                "schemaVersion": SCHEMA,
                "status": status,
                "ageSeconds": max(0, age_seconds),
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
    )


if __name__ == "__main__":
    main()
