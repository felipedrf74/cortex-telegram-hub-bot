#!/usr/bin/env python3
"""Durable begin/checkpoint/complete/recover boundary for the DR installer."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from typing import Any, NoReturn


SCHEMA = "nexus.application-dr-install-transaction.v2"
RECEIPT_SCHEMA = "nexus.application-dr-install.v2"
MAX_BYTES = 8 * 1024 * 1024
TIMERS = (
    "nexus-application-dr-backup.timer",
    "nexus-application-dr-health.timer",
)
SHA256 = re.compile(r"^[0-9a-f]{64}$")
DRILL_USER = re.compile(r"^[a-z_][a-z0-9_-]*$")
ENABLED_STATES = frozenset({"enabled", "disabled", "not-found"})
ACTIVE_STATES = frozenset({"active", "inactive"})
ALLOWED_TARGETS = frozenset({
    "/usr/local/libexec/nexus-application-dr/application-dr-backup.sh",
    "/usr/local/libexec/nexus-application-dr/application-dr-sqlite.py",
    "/usr/local/libexec/nexus-application-dr/production-migration-lineages.json",
    "/usr/local/libexec/nexus-application-dr/application-dr-retention.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-version-retention.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-storage-controls.py",
    "/usr/local/libexec/nexus-application-dr/aws-credential-process-boundary.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-crl-parameters.mjs",
    "/usr/local/libexec/nexus-application-dr/application-dr-cloudformation-activate.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-cloudformation-parameter-digest.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-install-transaction.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-roles-anywhere-probe.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-health-check.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-alert.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-recovery-runtime.mjs",
    "/usr/local/libexec/nexus-application-dr/release-recovery-runtime-identity.mjs",
    "/usr/local/libexec/nexus-application-dr/application-dr-recovery-archive.py",
    "/usr/local/libexec/nexus-application-dr/application-dr-archive.py",
    "/usr/local/libexec/nexus-application-dr/release-runtime-dependencies.mjs",
    "/usr/local/libexec/nexus-application-dr/application-dr-restore-drill.sh",
    "/usr/local/libexec/nexus-application-dr/application-dr-isolated-harness.sh",
    "/etc/nexus-application-dr/release-evidence-public-key.pem",
    "/etc/systemd/system/nexus-application-dr-backup.service",
    "/etc/systemd/system/nexus-application-dr-backup.timer",
    "/etc/systemd/system/nexus-application-dr-health.service",
    "/etc/systemd/system/nexus-application-dr-health.timer",
    "/etc/systemd/system/nexus-application-dr-alert@.service",
    "/etc/systemd/system/nexus-application-dr-install-recovery.service",
})


def fail(message: str) -> NoReturn:
    raise SystemExit(f"application DR install transaction: {message}")


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        fail(f"cannot hash {path}: {error}")
    return digest.hexdigest()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, payload: dict[str, Any], *, exclusive: bool) -> None:
    body = canonical_json(payload) + b"\n"
    temporary = path.parent / f".{path.name}.{os.getpid()}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        descriptor = os.open(temporary, flags, 0o600)
        try:
            offset = 0
            while offset < len(body):
                written = os.write(descriptor, body[offset:])
                if written <= 0:
                    fail("could not write complete transaction state")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if exclusive:
            os.link(temporary, path, follow_symlinks=False)
            temporary.unlink()
        else:
            os.replace(temporary, path)
        fsync_directory(path.parent)
    except FileExistsError:
        fail(f"refusing to overwrite existing transaction file {path}")
    except OSError as error:
        fail(f"could not persist {path}: {error}")
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def private_root_file(path: Path, *, label: str) -> None:
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
        or metadata.st_uid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        fail(f"{label} must be a canonical root-owned mode-0600 file")


def load_journal(path: Path) -> dict[str, Any]:
    private_root_file(path, label="install journal")
    try:
        body = path.read_bytes()
    except OSError as error:
        fail(f"install journal is unreadable: {error}")
    if not body or len(body) > MAX_BYTES:
        fail("install journal size is outside its bound")
    try:
        value = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"install journal is invalid JSON: {error}")
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        fail("install journal schema is invalid")
    validate_journal_shape(value, journal_path=path)
    return value


def validate_journal_shape(
    value: dict[str, Any],
    *,
    journal_path: Path,
) -> None:
    state_dir = journal_path.parent
    transaction = Path(str(value.get("transactionDirectory", "")))
    recovery_program = Path(str(value.get("recoveryProgram", "")))
    assets = value.get("assets")
    timer_before = value.get("timerBefore")
    required_timer_keys = {
        "backupEnabled",
        "backupEnabledState",
        "backupActive",
        "backupActiveState",
        "healthEnabled",
        "healthEnabledState",
        "healthActive",
        "healthActiveState",
        "recoveryServiceEnabled",
        "recoveryServiceEnabledState",
    }
    if (
        transaction.parent != state_dir
        or not transaction.name.startswith(".install-transaction.v2.")
        or recovery_program
        != state_dir / "install-recovery-program.v2.py"
        or not SHA256.fullmatch(str(value.get("sourceRootSha256", "")))
        or not SHA256.fullmatch(str(value.get("layoutSha256", "")))
        or not SHA256.fullmatch(str(value.get("recoveryProgramSha256", "")))
        or not isinstance(assets, list)
        or not 1 <= len(assets) <= 64
        or not isinstance(value.get("committedIndices"), list)
        or not isinstance(value.get("recoveredIndices"), list)
        or not isinstance(timer_before, dict)
        or set(timer_before) != required_timer_keys
        or any(
            not isinstance(timer_before[key], bool)
            for key in (
                "backupEnabled",
                "backupActive",
                "healthEnabled",
                "healthActive",
                "recoveryServiceEnabled",
            )
        )
        or timer_before["backupEnabledState"] not in ENABLED_STATES
        or timer_before["healthEnabledState"] not in ENABLED_STATES
        or timer_before["recoveryServiceEnabledState"] not in ENABLED_STATES
        or timer_before["backupActiveState"] not in ACTIVE_STATES
        or timer_before["healthActiveState"] not in ACTIVE_STATES
        or timer_before["backupEnabled"]
        != (timer_before["backupEnabledState"] == "enabled")
        or timer_before["healthEnabled"]
        != (timer_before["healthEnabledState"] == "enabled")
        or timer_before["recoveryServiceEnabled"]
        != (timer_before["recoveryServiceEnabledState"] == "enabled")
        or timer_before["backupActive"]
        != (timer_before["backupActiveState"] == "active")
        or timer_before["healthActive"]
        != (timer_before["healthActiveState"] == "active")
        or not DRILL_USER.fullmatch(str(value.get("drillUser", "")))
        or not isinstance(value.get("drillUserCreated"), bool)
        or not isinstance(value.get("healthTimerEnabledByInstall"), bool)
    ):
        fail("install journal control binding is invalid")
    for checkpoint_name in ("committedIndices", "recoveredIndices"):
        checkpoints = value[checkpoint_name]
        if (
            any(
                isinstance(index, bool)
                or not isinstance(index, int)
                or index < 0
                or index >= len(assets)
                for index in checkpoints
            )
            or len(set(checkpoints)) != len(checkpoints)
        ):
            fail(
                "install journal "
                f"{checkpoint_name.removesuffix('Indices')} checkpoints "
                "are invalid",
            )
    for expected_index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            fail("install journal asset entry is invalid")
        target = Path(str(asset.get("target", "")))
        stage = Path(str(asset.get("stage", "")))
        backup_value = asset.get("backup")
        backup = Path(backup_value) if isinstance(backup_value, str) else None
        if (
            asset.get("index") != expected_index
            or str(target) not in ALLOWED_TARGETS
            or stage.parent != target.parent
            or not stage.name.startswith(".nexus-application-dr.stage.")
            or (
                backup is not None
                and (
                    backup.parent != target.parent
                    or not backup.name.startswith(
                        ".nexus-application-dr.backup.",
                    )
                )
            )
            or not isinstance(asset.get("hadTarget"), bool)
            or asset["hadTarget"] != (backup is not None)
            or asset.get("owner") != "root:root"
            or asset.get("mode") not in {"0644", "0700", "0755"}
            or not SHA256.fullmatch(str(asset.get("sourceSha256", "")))
            or (
                asset["hadTarget"]
                and not SHA256.fullmatch(
                    str(asset.get("predecessorSha256", "")),
                )
            )
            or (
                asset["hadTarget"]
                and asset.get("predecessorMode")
                not in {"0600", "0644", "0700", "0755"}
            )
        ):
            fail("install journal asset binding is invalid")
    targets = [str(asset["target"]) for asset in assets]
    stages = [str(asset["stage"]) for asset in assets]
    backups = [
        str(asset["backup"])
        for asset in assets
        if asset["backup"] is not None
    ]
    if (
        set(targets) != ALLOWED_TARGETS
        or len(set(targets)) != len(targets)
        or len(set(stages)) != len(stages)
        or len(set(backups)) != len(backups)
        or set(targets) & set(stages)
        or set(targets) & set(backups)
        or set(stages) & set(backups)
    ):
        fail("install journal does not bind the exact distinct asset set")


def validate_operation_paths(
    *,
    journal: Path,
    receipt: Path,
    program: Path,
    lock: Path | None = None,
) -> None:
    state_dir = Path("/var/lib/nexus-application-dr")
    if (
        journal != state_dir / "install-in-progress.v1"
        or receipt.parent != state_dir
        or receipt.name
        not in {
            "install-receipt.v2.json",
            "install-recovery-receipt.v2.json",
        }
        or program != state_dir / "install-recovery-program.v2.py"
        or (
            lock is not None
            and lock != state_dir / "backup.lock"
        )
    ):
        fail("install transaction operation paths are outside the exact boundary")


def bool_text(value: str, label: str) -> bool:
    if value not in {"true", "false"}:
        fail(f"{label} must be true or false")
    return value == "true"


def enabled_state(value: str, label: str) -> str:
    if value not in ENABLED_STATES:
        fail(f"{label} must be enabled, disabled, or not-found")
    return value


def active_state(value: str, label: str) -> str:
    if value not in ACTIVE_STATES:
        fail(f"{label} must be active or inactive")
    return value


def regular_digest(path: Path, expected: str, label: str) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or sha256_file(path) != expected
    ):
        fail(f"{label} differs from the transaction binding")


def parse_plan(path: Path) -> list[dict[str, Any]]:
    private_root_file(path, label="install plan")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        fail(f"install plan is unreadable: {error}")
    entries: list[dict[str, Any]] = []
    for expected_index, line in enumerate(lines):
        columns = line.split("\t")
        if len(columns) != 8:
            fail("install plan row shape is invalid")
        raw_index, source, target, stage, backup, had, owner, mode = columns
        if raw_index != str(expected_index):
            fail("install plan indices are not canonical")
        source_path = Path(source)
        target_path = Path(target)
        stage_path = Path(stage)
        backup_path = Path(backup) if backup else None
        if (
            not source_path.is_absolute()
            or not target_path.is_absolute()
            or not stage_path.is_absolute()
            or (backup_path is not None and not backup_path.is_absolute())
            or owner != "root:root"
            or mode not in {"0644", "0700", "0755"}
        ):
            fail("install plan path or ownership binding is invalid")
        had_target = bool_text(had, "had-target")
        if had_target != (backup_path is not None):
            fail("install plan predecessor binding is incomplete")
        regular_digest(stage_path, sha256_file(source_path), "staged asset")
        predecessor_sha = None
        predecessor_mode = None
        if backup_path is not None:
            regular_digest(
                backup_path,
                sha256_file(backup_path),
                "predecessor backup",
            )
            predecessor_sha = sha256_file(backup_path)
            predecessor_mode = f"{stat.S_IMODE(backup_path.stat().st_mode):04o}"
        entries.append({
            "index": expected_index,
            "source": str(source_path),
            "sourceSha256": sha256_file(source_path),
            "target": str(target_path),
            "stage": str(stage_path),
            "backup": None if backup_path is None else str(backup_path),
            "hadTarget": had_target,
            "predecessorSha256": predecessor_sha,
            "predecessorMode": predecessor_mode,
            "owner": owner,
            "mode": mode,
        })
    if not entries:
        fail("install plan is empty")
    return entries


def journal_digest_view(journal: dict[str, Any]) -> dict[str, Any]:
    return {
        key: journal[key]
        for key in (
            "schema",
            "sourceRootSha256",
            "layoutSha256",
            "recoveryProgramSha256",
            "assets",
            "timerBefore",
        )
    }


def checkpoint(path: Path, journal: dict[str, Any], phase: str) -> dict[str, Any]:
    updated = {**journal, "phase": phase, "updatedAt": utc_now()}
    atomic_write(path, updated, exclusive=False)
    return updated


def run_systemctl(
    arguments: list[str],
    *,
    check: bool = True,
    capture: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            ["/usr/bin/systemctl", *arguments],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"systemctl {' '.join(arguments)} did not complete: {error}")
    if check and result.returncode != 0:
        fail(f"systemctl {' '.join(arguments)} failed")
    return result


def observed_systemctl_state(query: str, unit: str) -> str:
    if query not in {"is-enabled", "is-active"}:
        fail("systemctl state query is outside the exact allowlist")
    result = run_systemctl([query, unit], check=False, capture=True)
    if len(result.stdout) > 128:
        fail(f"systemctl {query} returned oversized state")
    try:
        value = result.stdout.decode("ascii", errors="strict").strip()
    except UnicodeDecodeError:
        fail(f"systemctl {query} returned a non-ASCII state")
    allowed = ENABLED_STATES if query == "is-enabled" else ACTIVE_STATES
    if value not in allowed:
        fail(f"systemctl {query} returned ambiguous state for {unit}")
    expected_success = value in {"enabled", "active"}
    if (result.returncode == 0) is not expected_success:
        fail(f"systemctl {query} status disagrees with its state for {unit}")
    return value


def restore_enabled_state(unit: str, expected: str) -> None:
    if expected == "enabled":
        run_systemctl(["enable", unit])
    elif expected == "disabled":
        run_systemctl(["disable", unit])
    elif expected == "not-found":
        # A first-install rollback may remove the unit before this transition.
        # A failed disable is acceptable only when the subsequent exact query
        # proves the unit is genuinely absent.
        run_systemctl(["disable", unit], check=False)
    else:
        fail(f"unsupported predecessor enabled state for {unit}")
    if observed_systemctl_state("is-enabled", unit) != expected:
        fail(f"systemctl enabled state was not restored exactly for {unit}")


def restore_active_state(unit: str, expected: str) -> None:
    if expected == "active":
        run_systemctl(["start", unit])
    elif expected == "inactive":
        run_systemctl(["stop", unit], check=False)
    else:
        fail(f"unsupported predecessor active state for {unit}")
    if observed_systemctl_state("is-active", unit) != expected:
        fail(f"systemctl active state was not restored exactly for {unit}")


def identity_absent(database: str, identity: str) -> bool:
    if database not in {"passwd", "group"}:
        fail("identity database is outside the exact allowlist")
    try:
        result = subprocess.run(
            ["/usr/bin/getent", database, identity],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"could not verify {database} restoration: {error}")
    if result.returncode == 2:
        return True
    if result.returncode == 0:
        return False
    fail(f"getent {database} returned ambiguous predecessor state")


def remove_created_identity(identity: str) -> None:
    for executable, database in (
        ("/usr/sbin/userdel", "passwd"),
        ("/usr/sbin/groupdel", "group"),
    ):
        try:
            subprocess.run(
                [executable, identity],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            fail(f"could not restore drill {database} state: {error}")
        if not identity_absent(database, identity):
            fail(f"created drill {database} identity still exists after rollback")


def remove_durable(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    fsync_directory(path.parent)


def write_receipt(
    path: Path,
    *,
    status: str,
    journal: dict[str, Any],
) -> None:
    payload = {
        "schema": RECEIPT_SCHEMA,
        "status": status,
        "observedAt": utc_now(),
        "transactionBindingSha256": sha256_bytes(
            canonical_json(journal_digest_view(journal)),
        ),
        "installedAssets": len(journal["assets"]),
        "configurationWritten": False,
    }
    atomic_write(path, payload, exclusive=False)


def acquire_lock(path: Path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    os.fchmod(descriptor, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(descriptor)
        fail(f"could not acquire install/backup lock: {error}")
    return descriptor


def begin(args: argparse.Namespace) -> None:
    if args.journal.exists() or args.journal.is_symlink():
        fail("unfinished install journal already exists; recover it first")
    entries = parse_plan(args.plan)
    recovery_sha = sha256_file(args.recovery_program)
    journal = {
        "schema": SCHEMA,
        "status": "in_progress",
        "phase": "prepared",
        "startedAt": utc_now(),
        "updatedAt": utc_now(),
        "sourceRootSha256": sha256_bytes(
            str(args.source_root).encode("utf-8"),
        ),
        "layoutSha256": sha256_file(args.layout),
        "recoveryProgram": str(args.recovery_program),
        "recoveryProgramSha256": recovery_sha,
        "transactionDirectory": str(args.plan.parent),
        "assets": entries,
        "committedIndices": [],
        "recoveredIndices": [],
        "drillUser": args.drill_user,
        "drillUserCreated": False,
        "healthTimerEnabledByInstall": False,
        "timerBefore": {
            "backupEnabled": bool_text(
                args.backup_timer_enabled,
                "backup timer enabled",
            ),
            "backupEnabledState": enabled_state(
                args.backup_timer_enabled_state,
                "backup timer enabled state",
            ),
            "backupActive": bool_text(
                args.backup_timer_active,
                "backup timer active",
            ),
            "backupActiveState": active_state(
                args.backup_timer_active_state,
                "backup timer active state",
            ),
            "healthEnabled": bool_text(
                args.health_timer_enabled,
                "health timer enabled",
            ),
            "healthEnabledState": enabled_state(
                args.health_timer_enabled_state,
                "health timer enabled state",
            ),
            "healthActive": bool_text(
                args.health_timer_active,
                "health timer active",
            ),
            "healthActiveState": active_state(
                args.health_timer_active_state,
                "health timer active state",
            ),
            "recoveryServiceEnabled": bool_text(
                args.recovery_service_enabled,
                "recovery service enabled",
            ),
            "recoveryServiceEnabledState": enabled_state(
                args.recovery_service_enabled_state,
                "recovery service enabled state",
            ),
        },
    }
    validate_journal_shape(journal, journal_path=args.journal)
    atomic_write(args.journal, journal, exclusive=True)
    print(json.dumps({"ok": True, "phase": "prepared"}, separators=(",", ":")))


def update(args: argparse.Namespace) -> None:
    journal = load_journal(args.journal)
    if journal.get("status") != "in_progress":
        fail("install journal is not in progress")
    updated = dict(journal)
    if args.committed_index is not None:
        if (
            args.committed_index < 0
            or args.committed_index >= len(updated["assets"])
            or args.committed_index in updated["committedIndices"]
        ):
            fail("committed checkpoint is outside the exact remaining assets")
        updated["committedIndices"] = [
            *updated["committedIndices"],
            args.committed_index,
        ]
    if args.drill_user_created:
        updated["drillUserCreated"] = True
    if args.health_timer_enabled_by_install:
        updated["healthTimerEnabledByInstall"] = True
    checkpoint(args.journal, updated, args.phase)


def validate_program(journal: dict[str, Any], program: Path) -> None:
    private_root_file(program, label="install recovery program")
    if (
        journal.get("recoveryProgram") != str(program)
        or journal.get("recoveryProgramSha256") != sha256_file(program)
    ):
        fail("running recovery program differs from the transaction binding")


def preflight_recovery(journal: dict[str, Any]) -> None:
    recovered = set(journal["recoveredIndices"])
    for asset in journal["assets"]:
        target = Path(asset["target"])
        backup = Path(asset["backup"]) if asset["backup"] else None
        target_exists = target.exists() or target.is_symlink()
        backup_exists = backup is not None and (
            backup.exists() or backup.is_symlink()
        )
        stage = Path(asset["stage"])
        stage_exists = stage.exists() or stage.is_symlink()
        target_sha = None
        if backup_exists:
            regular_digest(
                backup,
                asset["predecessorSha256"],
                f"predecessor for {target}",
            )
        if target_exists:
            regular_digest(
                target,
                sha256_file(target),
                f"current target {target}",
            )
            target_sha = sha256_file(target)
            allowed = {asset["sourceSha256"]}
            if asset["predecessorSha256"] is not None:
                allowed.add(asset["predecessorSha256"])
            if target_sha not in allowed:
                fail(f"current target {target} is neither reviewed source nor predecessor")
        if asset["hadTarget"]:
            if not backup_exists and target_sha != asset["predecessorSha256"]:
                fail(f"predecessor for {target} is unavailable during recovery")
        elif backup_exists:
            fail(f"unexpected predecessor backup exists for {target}")
        if asset["index"] in recovered:
            if asset["hadTarget"]:
                if (
                    backup_exists
                    or target_sha != asset["predecessorSha256"]
                    or f"{stat.S_IMODE(target.stat().st_mode):04o}"
                    != asset["predecessorMode"]
                ):
                    fail(f"recovered predecessor checkpoint differs for {target}")
            elif target_exists:
                fail(f"recovered absent-target checkpoint differs for {target}")
            if stage_exists:
                fail(f"recovered stage checkpoint still exists for {target}")


def restore_asset(asset: dict[str, Any]) -> None:
    target = Path(asset["target"])
    backup = Path(asset["backup"]) if asset["backup"] else None
    if asset["hadTarget"]:
        if target.exists() or target.is_symlink():
            regular_digest(
                target,
                sha256_file(target),
                f"current target {target}",
            )
            target_sha = sha256_file(target)
        else:
            target_sha = None
        if target_sha == asset["predecessorSha256"]:
            if backup is not None:
                remove_durable(backup)
        else:
            if backup is None or not (backup.exists() or backup.is_symlink()):
                fail(f"predecessor backup for {target} is missing")
            regular_digest(
                backup,
                asset["predecessorSha256"],
                f"predecessor for {target}",
            )
            os.replace(backup, target)
        os.chown(target, 0, 0)
        os.chmod(target, int(asset["predecessorMode"], 8))
        fsync_directory(target.parent)
        regular_digest(
            target,
            asset["predecessorSha256"],
            f"restored predecessor {target}",
        )
    else:
        remove_durable(target)
    remove_durable(Path(asset["stage"]))


def restore_timers(journal: dict[str, Any]) -> None:
    before = journal["timerBefore"]
    desired = (
        (
            TIMERS[0],
            before["backupEnabledState"],
            before["backupActiveState"],
        ),
        (
            TIMERS[1],
            before["healthEnabledState"],
            before["healthActiveState"],
        ),
    )
    for unit, enabled, _active in desired:
        restore_enabled_state(unit, enabled)
    for unit, _enabled, active in desired:
        restore_active_state(unit, active)
    restore_enabled_state(
        "nexus-application-dr-install-recovery.service",
        before["recoveryServiceEnabledState"],
    )


def recover(args: argparse.Namespace) -> None:
    validate_operation_paths(
        journal=args.journal,
        receipt=args.receipt,
        program=args.program,
        lock=args.lock,
    )
    lock_descriptor = acquire_lock(args.lock)
    try:
        journal = load_journal(args.journal)
        validate_program(journal, args.program)
        run_systemctl(["stop", *TIMERS], check=False)
        checkpoint(args.journal, journal, "recovering-preflight")
        preflight_recovery(journal)
        recovered = set(journal["recoveredIndices"])
        for asset in reversed(journal["assets"]):
            if asset["index"] in recovered:
                continue
            restore_asset(asset)
            journal = {
                **journal,
                "recoveredIndices": [
                    *journal["recoveredIndices"],
                    asset["index"],
                ],
            }
            journal = checkpoint(
                args.journal,
                journal,
                f"recovered-asset-{asset['index']}",
            )
            recovered.add(asset["index"])
        run_systemctl(["daemon-reload"])
        if journal.get("drillUserCreated") is True:
            remove_created_identity(journal["drillUser"])
        restore_timers(journal)
        remove_durable(args.journal)
        write_receipt(args.receipt, status="rolled_back", journal=journal)
        try:
            shutil.rmtree(journal["transactionDirectory"])
        except FileNotFoundError:
            pass
        fsync_directory(Path(journal["transactionDirectory"]).parent)
    finally:
        os.close(lock_descriptor)


def complete(args: argparse.Namespace) -> None:
    validate_operation_paths(
        journal=args.journal,
        receipt=args.receipt,
        program=args.program,
    )
    journal = load_journal(args.journal)
    validate_program(journal, args.program)
    if sorted(journal.get("committedIndices", [])) != list(
        range(len(journal["assets"])),
    ):
        fail("not every planned asset has a durable commit checkpoint")
    for asset in journal["assets"]:
        target = Path(asset["target"])
        regular_digest(target, asset["sourceSha256"], f"installed target {target}")
        if f"{stat.S_IMODE(target.stat().st_mode):04o}" != asset["mode"]:
            fail(f"installed target mode differs for {target}")
    final = checkpoint(args.journal, journal, "verified")
    # Journal removal is the durable commit point. A later crash can leave
    # removable predecessor/stage debris but cannot trigger rollback of a
    # fully verified install. The pass receipt is published only afterwards.
    remove_durable(args.journal)
    write_receipt(args.receipt, status="passed", journal=final)
    for asset in final["assets"]:
        if asset["backup"]:
            remove_durable(Path(asset["backup"]))
        remove_durable(Path(asset["stage"]))
    try:
        shutil.rmtree(final["transactionDirectory"])
    except FileNotFoundError:
        pass
    fsync_directory(Path(final["transactionDirectory"]).parent)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="operation", required=True)

    begin_parser = subparsers.add_parser("begin")
    begin_parser.add_argument("--journal", required=True, type=Path)
    begin_parser.add_argument("--plan", required=True, type=Path)
    begin_parser.add_argument("--source-root", required=True, type=Path)
    begin_parser.add_argument("--layout", required=True, type=Path)
    begin_parser.add_argument("--recovery-program", required=True, type=Path)
    begin_parser.add_argument("--drill-user", required=True)
    begin_parser.add_argument("--backup-timer-enabled", required=True)
    begin_parser.add_argument("--backup-timer-enabled-state", required=True)
    begin_parser.add_argument("--backup-timer-active", required=True)
    begin_parser.add_argument("--backup-timer-active-state", required=True)
    begin_parser.add_argument("--health-timer-enabled", required=True)
    begin_parser.add_argument("--health-timer-enabled-state", required=True)
    begin_parser.add_argument("--health-timer-active", required=True)
    begin_parser.add_argument("--health-timer-active-state", required=True)
    begin_parser.add_argument("--recovery-service-enabled", required=True)
    begin_parser.add_argument(
        "--recovery-service-enabled-state",
        required=True,
    )

    update_parser = subparsers.add_parser("checkpoint")
    update_parser.add_argument("--journal", required=True, type=Path)
    update_parser.add_argument("--phase", required=True)
    update_parser.add_argument("--committed-index", type=int)
    update_parser.add_argument("--drill-user-created", action="store_true")
    update_parser.add_argument(
        "--health-timer-enabled-by-install",
        action="store_true",
    )

    for name in ("recover", "complete"):
        operation_parser = subparsers.add_parser(name)
        operation_parser.add_argument("--journal", required=True, type=Path)
        operation_parser.add_argument("--receipt", required=True, type=Path)
        operation_parser.add_argument("--program", required=True, type=Path)
        if name == "recover":
            operation_parser.add_argument("--lock", required=True, type=Path)

    args = parser.parse_args()
    if os.geteuid() != 0:
        fail("must run as root")
    if args.operation == "begin":
        begin(args)
    elif args.operation == "checkpoint":
        update(args)
    elif args.operation == "recover":
        recover(args)
    else:
        complete(args)


if __name__ == "__main__":
    main()
