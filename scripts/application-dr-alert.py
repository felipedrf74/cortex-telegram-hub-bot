#!/usr/bin/env python3
"""Persist and emit a redacted local alert for application DR failures."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from typing import Any, NoReturn


SCHEMA = "NexusApplicationDrAlertV1"
UNITS = {
    "nexus-application-dr-backup.service",
    "nexus-application-dr-health.service",
}
SYSTEMD_VALUE = re.compile(r"^[A-Za-z0-9_.:@-]{1,128}$")


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def timestamp(value: str | None, test_mode: bool) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if not test_mode:
        fail("--now is available only in unprivileged test mode")
    if not value.endswith("Z"):
        fail("--now is invalid")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise SystemExit("--now is invalid") from error
    if result.tzinfo is None:
        fail("--now is invalid")
    return result.astimezone(timezone.utc)


def evidence_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(f"{label} is invalid")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise SystemExit(f"{label} is invalid") from error
    if result.tzinfo is None:
        fail(f"{label} is invalid")
    return result.astimezone(timezone.utc)


def trusted_directory(path: Path, owner_uid: int, boundary: Path, label: str) -> None:
    try:
        metadata = path.lstat()
        canonical = path.resolve(strict=True)
        canonical_boundary = boundary.resolve(strict=True)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        canonical != path
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != owner_uid
        or stat.S_IMODE(metadata.st_mode) & 0o077
    ):
        fail(f"{label} must be canonical and owner-private")
    try:
        path.relative_to(canonical_boundary)
    except ValueError:
        fail(f"{label} is outside the trusted boundary")


def trusted_executable(path: Path, owner_uid: int, boundary: Path, label: str) -> None:
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
        or stat.S_IMODE(metadata.st_mode) & 0o022
        or stat.S_IMODE(metadata.st_mode) & 0o111 == 0
    ):
        fail(f"{label} is outside the executable trust boundary")
    try:
        path.relative_to(boundary.resolve(strict=True))
    except ValueError:
        fail(f"{label} is outside the trusted boundary")


def trusted_alert(
    path: Path,
    owner_uid: int,
    expected_unit: str,
) -> dict[str, Any] | None:
    if not path.exists() and not path.is_symlink():
        return None
    try:
        metadata = path.lstat()
        canonical = path.resolve(strict=True)
    except OSError as error:
        fail(f"existing alert evidence is unavailable: {error}")
    if (
        canonical != path
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != owner_uid
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_size > 64 * 1024
    ):
        fail("existing alert evidence is unsafe")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"existing alert evidence is invalid: {error}")
    if not isinstance(payload, dict):
        fail("existing alert evidence is invalid")
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
        or payload.get("schemaVersion") != SCHEMA
        or payload.get("unit") != expected_unit
        or isinstance(payload.get("occurrences"), bool)
        or not isinstance(payload.get("occurrences"), int)
        or not 1 <= payload["occurrences"] <= 2_147_483_647
    ):
        fail("existing alert evidence is invalid")
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
        fail("existing alert evidence is invalid")
    first_observed = evidence_timestamp(
        payload.get("firstObservedAt"),
        "existing alert firstObservedAt",
    )
    last_observed = evidence_timestamp(
        payload.get("lastObservedAt"),
        "existing alert lastObservedAt",
    )
    if last_observed < first_observed:
        fail("existing alert observation interval is invalid")
    if status == "active":
        if payload.get("operatorActionRequired") is not True:
            fail("existing alert evidence is invalid")
    else:
        if payload.get("operatorActionRequired") is not False:
            fail("existing alert evidence is invalid")
        resolved_at = evidence_timestamp(
            payload.get("resolvedAt"),
            "existing alert resolvedAt",
        )
        if resolved_at < last_observed:
            fail("existing alert resolution interval is invalid")
    return payload


def systemd_state(systemctl: Path, unit: str) -> dict[str, str]:
    try:
        result = subprocess.run(
            [
                str(systemctl),
                "show",
                unit,
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
        fail("systemd alert query timed out")
    if (
        result.returncode != 0
        or len(result.stdout) > 16 * 1024
        or len(result.stderr) > 16 * 1024
    ):
        fail("systemd alert query failed")
    values: dict[str, str] = {}
    try:
        lines = result.stdout.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise SystemExit("systemd alert query was not UTF-8") from error
    for line in lines:
        key, separator, value = line.partition("=")
        if separator != "=" or key not in {"ActiveState", "SubState", "Result"}:
            fail("systemd alert query returned an unexpected field")
        if key in values or SYSTEMD_VALUE.fullmatch(value) is None:
            fail("systemd alert query returned an invalid value")
        values[key] = value
    if set(values) != {"ActiveState", "SubState", "Result"}:
        fail("systemd alert query omitted a required field")
    return values


def atomic_replace(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.parent / f".{path.name}.tmp.{os.getpid()}"
    if temporary.exists() or temporary.is_symlink():
        fail("alert evidence temporary path already exists")
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
                fail("could not write complete alert evidence")
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--unit", required=True)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--systemctl", required=True, type=Path)
    parser.add_argument("--logger", required=True, type=Path)
    parser.add_argument("--expected-owner-uid", type=int, default=0)
    parser.add_argument("--trust-boundary", type=Path, default=Path("/"))
    parser.add_argument("--now")
    parser.add_argument("--test-mode", action="store_true")
    args = parser.parse_args()

    if os.geteuid() == 0 and args.test_mode:
        fail("test mode is forbidden for a privileged invocation")
    if not args.test_mode and os.geteuid() != 0:
        fail("production application DR alert hook must run as root")
    if args.expected_owner_uid != os.geteuid():
        fail("expected owner uid must equal the invoking uid")
    if args.unit not in UNITS:
        fail("alert unit is outside the exact allowlist")
    trusted_directory(
        args.state_dir,
        args.expected_owner_uid,
        args.trust_boundary,
        "state directory",
    )
    alerts = args.state_dir / "alerts"
    trusted_directory(alerts, args.expected_owner_uid, args.state_dir, "alerts directory")
    for executable, label in (
        (args.systemctl, "systemctl"),
        (args.logger, "logger"),
    ):
        if not executable.is_absolute():
            fail(f"{label} must be absolute")
        trusted_executable(
            executable,
            args.expected_owner_uid,
            args.trust_boundary,
            label,
        )

    observed = timestamp(args.now, args.test_mode)
    state = systemd_state(args.systemctl, args.unit)
    alert_path = alerts / f"{args.unit}.v1.json"
    prior = trusted_alert(
        alert_path,
        args.expected_owner_uid,
        args.unit,
    )
    prior_active = prior is not None and prior["status"] == "active"
    if (
        prior_active
        and observed
        < evidence_timestamp(
            prior.get("lastObservedAt"),
            "existing alert lastObservedAt",
        )
    ):
        fail("current alert observation predates existing evidence")
    occurrences = (
        min(int(prior["occurrences"]) + 1, 2_147_483_647)
        if prior_active
        else 1
    )
    first_observed = (
        prior["firstObservedAt"]
        if prior_active and isinstance(prior.get("firstObservedAt"), str)
        else observed.isoformat().replace("+00:00", "Z")
    )
    payload = {
        "schemaVersion": SCHEMA,
        "status": "active",
        "unit": args.unit,
        "firstObservedAt": first_observed,
        "lastObservedAt": observed.isoformat().replace("+00:00", "Z"),
        "occurrences": occurrences,
        "systemd": {
            "activeState": state["ActiveState"],
            "subState": state["SubState"],
            "result": state["Result"],
        },
        "operatorActionRequired": True,
    }
    atomic_replace(alert_path, payload)
    message = (
        f"nexus_application_dr_alert unit={args.unit} "
        f"activeState={state['ActiveState']} subState={state['SubState']} "
        f"result={state['Result']} occurrences={occurrences}"
    )
    try:
        logged = subprocess.run(
            [
                str(args.logger),
                "--priority",
                "auth.alert",
                "--tag",
                "nexus-application-dr",
                message,
            ],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        fail("operator alert logger timed out")
    if logged.returncode != 0 or len(logged.stderr) > 16 * 1024:
        fail("operator alert logger failed")
    print(
        json.dumps(
            {
                "ok": True,
                "schemaVersion": SCHEMA,
                "status": "active",
                "unit": args.unit,
                "occurrences": occurrences,
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
    )


if __name__ == "__main__":
    main()
