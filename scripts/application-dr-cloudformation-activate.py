#!/usr/bin/env python3
"""Inspect or execute one reviewed application DR activation change set."""

from __future__ import annotations

import argparse
import base64
import binascii
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time
from typing import Any, NoReturn


SCHEMA = "NexusApplicationDrCloudFormationActivationV2"
JOURNAL_SCHEMA = "NexusApplicationDrCloudFormationActivationJournalV1"
PROBE_SCHEMA = "NexusApplicationDrRolesAnywhereProbeV1"
CRL_LIVE_SCHEMA = "nexus.application-dr-crl-live-verification.v1"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
REGION = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$")
PROFILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")
STACK_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):cloudformation:"
    r"([a-z0-9-]+):([0-9]{12}):stack/"
    r"([A-Za-z][A-Za-z0-9-]{0,127})/"
    r"([A-Za-z0-9-]{1,128})$",
)
CHANGE_SET_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):cloudformation:"
    r"([a-z0-9-]+):([0-9]{12}):changeSet/"
    r"([A-Za-z][A-Za-z0-9-]{0,127})/"
    r"([A-Za-z0-9-]{1,128})$",
)
ROLES_ANYWHERE_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:"
    r"([a-z0-9-]+):([0-9]{12}):"
    r"(trust-anchor|profile)/([A-Za-z0-9-]{1,128})$",
)
IAM_ROLE_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):"
    r"role/(?:[A-Za-z0-9+=,.@_-]+/)*[A-Za-z0-9+=,.@_-]{1,64}$",
)
CRL_ID = re.compile(r"^[A-Za-z0-9-]{1,128}$")
CLOUDWATCH_ALARM_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):cloudwatch:"
    r"([a-z0-9-]+):([0-9]{12}):alarm:"
    r"([A-Za-z0-9_.:/=+@-]{1,255})$",
)
MAX_JSON_BYTES = 8 * 1024 * 1024
COMPLETED_STACK_STATUSES = {
    "CREATE_COMPLETE",
    "UPDATE_COMPLETE",
    "UPDATE_ROLLBACK_COMPLETE",
}
UPDATE_ACTIVE_STATUSES = {
    "UPDATE_IN_PROGRESS",
    "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
}
ROLLBACK_ACTIVE_STATUSES = {
    "UPDATE_ROLLBACK_IN_PROGRESS",
    "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
}
ROLLBACK_TERMINAL_STATUSES = {"UPDATE_ROLLBACK_COMPLETE"}
ACTIVATION_MONITORING_MINUTES = 30
ACTIVATION_ALARM_EVALUATION_PERIODS = 24
ACTIVATION_ALARM_PERIOD_SECONDS = 30
MAX_AWS_COMMAND_SECONDS = 30
MAX_VALIDATED_AWS_CALLS_BETWEEN_LEASE_RENEWALS = 7
ACTIVATION_LEASE_REQUIRED_MARGIN_SECONDS = 120
ACTIVATION_METRIC_NAMESPACE = "Nexus/ApplicationDR"
ACTIVATION_LEASE_METRIC = "ActivationLease"
MAX_PROBE_SECONDS = 300
MAX_CRL_VERIFY_SECONDS = 300
ROLES_ANYWHERE_CHANGES = {
    "RolesAnywhereTrustAnchor": "AWS::RolesAnywhere::TrustAnchor",
    "RolesAnywhereCertificateRevocationList": "AWS::RolesAnywhere::CRL",
    "BackupRolesAnywhereProfile": "AWS::RolesAnywhere::Profile",
    "RestoreRolesAnywhereProfile": "AWS::RolesAnywhere::Profile",
}
LIFECYCLE_CHANGES = {
    "DisasterRecoveryBucket": "AWS::S3::Bucket",
}
REQUIRED_OUTPUTS = {
    "BucketName",
    "DrPrefix",
    "BackupPrincipalArn",
    "RestorePrincipalArn",
    "RolesAnywhereActivation",
    "RolesAnywhereActivationRollbackAlarmArn",
    "LifecycleActivation",
    "LifecycleBootstrapReceiptSha256",
    "RolesAnywhereTrustAnchorArn",
    "RolesAnywhereCrlId",
    "BackupRolesAnywhereProfileArn",
    "RestoreRolesAnywhereProfileArn",
}


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        fail(f"value cannot be represented as canonical JSON: {error}")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        fail(f"could not hash {path.name}: {error}")
    return digest.hexdigest()


def canonical_file(
    path: Path,
    *,
    label: str,
    owner_uid: int,
    boundary: Path,
    executable: bool = False,
) -> None:
    try:
        metadata = path.lstat()
        canonical = path.resolve(strict=True)
        canonical_boundary = boundary.resolve(strict=True)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if canonical != path or stat.S_ISLNK(metadata.st_mode):
        fail(f"{label} must be canonical and must not traverse symlinks")
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        fail(f"{label} must be a single-link regular file")
    if metadata.st_uid != owner_uid:
        fail(f"{label} has an untrusted owner")
    mode = stat.S_IMODE(metadata.st_mode)
    if mode & 0o022:
        fail(f"{label} must not be group/world writable")
    if executable and mode & 0o111 == 0:
        fail(f"{label} must be executable")
    try:
        path.relative_to(canonical_boundary)
    except ValueError:
        fail(f"{label} is outside the trusted boundary")
    current = path.parent
    while True:
        try:
            current_metadata = current.lstat()
        except OSError as error:
            fail(f"{label} parent path is unavailable: {error}")
        if (
            current.resolve(strict=True) != current
            or stat.S_ISLNK(current_metadata.st_mode)
            or not stat.S_ISDIR(current_metadata.st_mode)
            or current_metadata.st_uid != owner_uid
            or stat.S_IMODE(current_metadata.st_mode) & 0o022
        ):
            fail(f"{label} parent path is outside the trusted ownership boundary")
        if current == canonical_boundary:
            break
        if current == current.parent:
            fail(f"{label} did not reach the trusted boundary")
        current = current.parent


def trusted_executable(
    path: Path,
    *,
    label: str,
    owner_uid: int,
    boundary: Path,
) -> Path:
    if not path.is_absolute():
        fail(f"{label} path must be absolute")
    try:
        canonical_boundary = boundary.resolve(strict=True)
        path.relative_to(canonical_boundary)
    except (OSError, ValueError):
        fail(f"{label} is outside the trusted boundary")
    pending = list(path.relative_to(canonical_boundary).parts)
    current = canonical_boundary
    followed = 0
    while pending:
        candidate = current / pending.pop(0)
        try:
            metadata = candidate.lstat()
        except OSError as error:
            fail(f"{label} is unavailable: {error}")
        if stat.S_ISLNK(metadata.st_mode):
            followed += 1
            if followed > 32 or metadata.st_uid != owner_uid:
                fail(f"{label} has an untrusted symlink chain")
            try:
                target = Path(os.readlink(candidate))
            except OSError as error:
                fail(f"{label} symlink is unreadable: {error}")
            target = target if target.is_absolute() else current / target
            normalized = Path(os.path.normpath(str(target)))
            try:
                relative_target = normalized.relative_to(canonical_boundary)
            except ValueError:
                fail(f"{label} symlink escapes the trusted boundary")
            pending = [*relative_target.parts, *pending]
            current = canonical_boundary
            continue
        if pending:
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or metadata.st_uid != owner_uid
                or stat.S_IMODE(metadata.st_mode) & 0o022
            ):
                fail(f"{label} traverses an untrusted parent directory")
            current = candidate
            continue
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != owner_uid
            or stat.S_IMODE(metadata.st_mode) & 0o022
            or stat.S_IMODE(metadata.st_mode) & 0o111 == 0
        ):
            fail(f"{label} target is not a trusted executable")
        return candidate
    fail(f"{label} path does not identify an executable")


def private_output_parent(
    path: Path,
    *,
    owner_uid: int,
    boundary: Path,
) -> None:
    if not path.is_absolute() or path == Path("/"):
        fail("evidence output must be an absolute non-root path")
    if path.exists() or path.is_symlink():
        fail("evidence output already exists")
    parent = path.parent
    try:
        parent_metadata = parent.lstat()
        canonical_parent = parent.resolve(strict=True)
        canonical_boundary = boundary.resolve(strict=True)
    except OSError as error:
        fail(f"evidence output parent is unavailable: {error}")
    if (
        canonical_parent != parent
        or stat.S_ISLNK(parent_metadata.st_mode)
        or not stat.S_ISDIR(parent_metadata.st_mode)
        or parent_metadata.st_uid != owner_uid
        or stat.S_IMODE(parent_metadata.st_mode) != 0o700
    ):
        fail("evidence output parent must be canonical and owner-private")
    try:
        parent.relative_to(canonical_boundary)
    except ValueError:
        fail("evidence output is outside the trusted boundary")
    current = parent
    while True:
        current_metadata = current.lstat()
        if (
            current.resolve(strict=True) != current
            or not stat.S_ISDIR(current_metadata.st_mode)
            or current_metadata.st_uid != owner_uid
            or stat.S_IMODE(current_metadata.st_mode) & 0o022
        ):
            fail("evidence output parent chain is outside the trusted boundary")
        if current == canonical_boundary:
            break
        if current == current.parent:
            fail("evidence output parent did not reach the trusted boundary")
        current = current.parent


def write_evidence(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.parent / (
        f".{path.name}.tmp.{os.getpid()}.{secrets.token_hex(8)}"
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(temporary, flags, 0o600)
        try:
            body = canonical_json(payload) + b"\n"
            os.fchmod(descriptor, 0o600)
            offset = 0
            while offset < len(body):
                written = os.write(descriptor, body[offset:])
                if written <= 0:
                    fail("could not write complete activation evidence")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.link(temporary, path, follow_symlinks=False)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as error:
        fail(f"could not create activation evidence: {error}")
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def write_journal(
    path: Path,
    payload: dict[str, Any],
    *,
    owner_uid: int,
    boundary: Path,
    create: bool,
) -> None:
    if create:
        private_output_parent(path, owner_uid=owner_uid, boundary=boundary)
    else:
        private_file(
            path,
            label="activation journal",
            owner_uid=owner_uid,
            boundary=boundary,
        )
    body = canonical_json(payload) + b"\n"
    temporary = path.parent / f".{path.name}.{secrets.token_hex(16)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        descriptor = os.open(temporary, flags, 0o600)
        try:
            offset = 0
            while offset < len(body):
                written = os.write(descriptor, body[offset:])
                if written <= 0:
                    fail("could not write complete activation journal")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if create:
            os.link(temporary, path, follow_symlinks=False)
            temporary.unlink()
        else:
            os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as error:
        fail(f"could not persist activation journal: {error}")
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def load_journal(
    path: Path,
    *,
    owner_uid: int,
    boundary: Path,
) -> dict[str, Any]:
    private_file(
        path,
        label="activation journal",
        owner_uid=owner_uid,
        boundary=boundary,
    )
    try:
        body = path.read_bytes()
    except OSError as error:
        fail(f"activation journal is unreadable: {error}")
    if len(body) > MAX_JSON_BYTES:
        fail("activation journal is oversized")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"activation journal is invalid JSON: {error}")
    if not isinstance(payload, dict):
        fail("activation journal must contain one JSON object")
    if payload.get("schemaVersion") != JOURNAL_SCHEMA:
        fail("activation journal schema is invalid")
    return payload


def normalized_parameters(value: Any, *, label: str) -> list[dict[str, str]]:
    if not isinstance(value, list):
        fail(f"{label} parameters are invalid")
    parameters: dict[str, str] = {}
    for entry in value:
        if not isinstance(entry, dict):
            fail(f"{label} parameter entry is invalid")
        key = entry.get("ParameterKey")
        parameter_value = entry.get("ParameterValue")
        if (
            not isinstance(key, str)
            or not key
            or not isinstance(parameter_value, str)
            or key in parameters
            or entry.get("UsePreviousValue") is True
            or (
                "ResolvedValue" in entry
                and entry.get("ResolvedValue") not in {None, ""}
            )
        ):
            fail(f"{label} parameters are not exact explicit string values")
        parameters[key] = parameter_value
    return [
        {"ParameterKey": key, "ParameterValue": parameters[key]}
        for key in sorted(parameters)
    ]


def parameter_map(parameters: list[dict[str, str]]) -> dict[str, str]:
    return {
        entry["ParameterKey"]: entry["ParameterValue"]
        for entry in parameters
    }


def normalized_outputs(value: Any) -> dict[str, str]:
    if not isinstance(value, list):
        fail("stack outputs are invalid")
    outputs: dict[str, str] = {}
    for entry in value:
        if not isinstance(entry, dict):
            fail("stack output entry is invalid")
        key = entry.get("OutputKey")
        output_value = entry.get("OutputValue")
        if (
            not isinstance(key, str)
            or not key
            or not isinstance(output_value, str)
            or key in outputs
        ):
            fail("stack outputs are not exact unique string values")
        outputs[key] = output_value
    missing = sorted(REQUIRED_OUTPUTS - set(outputs))
    if missing:
        fail(f"stack is missing required activation outputs: {', '.join(missing)}")
    return outputs


def normalized_string_list(
    value: Any,
    *,
    label: str,
    maximum: int,
) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > maximum:
        fail(f"{label} is invalid")
    normalized: set[str] = set()
    for entry in value:
        if not isinstance(entry, str) or not entry or entry in normalized:
            fail(f"{label} is not an exact unique string list")
        normalized.add(entry)
    return sorted(normalized)


def normalized_tags(value: Any, *, label: str) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 50:
        fail(f"{label} tags are invalid")
    tags: dict[str, str] = {}
    for entry in value:
        if (
            not isinstance(entry, dict)
            or set(entry) != {"Key", "Value"}
            or not isinstance(entry.get("Key"), str)
            or not isinstance(entry.get("Value"), str)
            or not 1 <= len(entry["Key"]) <= 128
            or len(entry["Value"]) > 256
            or entry["Key"] in tags
        ):
            fail(f"{label} tags are not exact unique key/value pairs")
        tags[entry["Key"]] = entry["Value"]
    return [
        {"Key": key, "Value": tags[key]}
        for key in sorted(tags)
    ]


def normalized_rollback_configuration(
    value: Any,
    *,
    label: str,
) -> dict[str, Any]:
    if value is None:
        value = {}
    if not isinstance(value, dict) or not set(value).issubset(
        {"RollbackTriggers", "MonitoringTimeInMinutes"},
    ):
        fail(f"{label} rollback configuration is invalid")
    triggers = value.get("RollbackTriggers", [])
    monitoring = value.get("MonitoringTimeInMinutes", 0)
    if (
        not isinstance(triggers, list)
        or len(triggers) > 5
        or isinstance(monitoring, bool)
        or not isinstance(monitoring, int)
        or not 0 <= monitoring <= 180
    ):
        fail(f"{label} rollback configuration is invalid")
    normalized: dict[tuple[str, str], dict[str, str]] = {}
    for trigger in triggers:
        if (
            not isinstance(trigger, dict)
            or set(trigger) != {"Arn", "Type"}
            or not isinstance(trigger.get("Arn"), str)
            or not trigger["Arn"].startswith("arn:")
            or trigger.get("Type")
            not in {
                "AWS::CloudWatch::Alarm",
                "AWS::CloudWatch::CompositeAlarm",
            }
        ):
            fail(f"{label} rollback trigger is invalid")
        key = (trigger["Arn"], trigger["Type"])
        if key in normalized:
            fail(f"{label} rollback triggers are not unique")
        normalized[key] = {
            "Arn": trigger["Arn"],
            "Type": trigger["Type"],
        }
    return {
        "rollbackTriggers": [
            normalized[key]
            for key in sorted(normalized)
        ],
        "monitoringTimeInMinutes": monitoring,
    }


def normalized_role_arn(value: Any, *, label: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or IAM_ROLE_ARN.fullmatch(value) is None:
        fail(f"{label} execution role ARN is invalid")
    return value


def normalized_stack_controls(stack: dict[str, Any]) -> dict[str, Any]:
    disable_rollback = stack.get("DisableRollback")
    termination_protection = stack.get("EnableTerminationProtection")
    if not isinstance(disable_rollback, bool):
        fail("stack DisableRollback control is missing or invalid")
    if not isinstance(termination_protection, bool):
        fail("stack termination-protection control is missing or invalid")
    if termination_protection is not True:
        fail("stack termination protection must be enabled before activation")
    return {
        "notificationArns": normalized_string_list(
            stack.get("NotificationARNs"),
            label="stack notification ARNs",
            maximum=5,
        ),
        "rollbackConfiguration": normalized_rollback_configuration(
            stack.get("RollbackConfiguration"),
            label="stack",
        ),
        "tags": normalized_tags(stack.get("Tags"), label="stack"),
        "executionRoleArn": normalized_role_arn(
            stack.get("RoleARN"),
            label="stack",
        ),
        "disableRollback": disable_rollback,
        "terminationProtection": termination_protection,
    }


def validate_change_set_controls(
    payload: dict[str, Any],
    *,
    current_controls: dict[str, Any],
    expected_rollback_configuration: dict[str, Any],
) -> dict[str, Any]:
    desired_controls = {
        "notificationArns": normalized_string_list(
            payload.get("NotificationARNs"),
            label="change-set notification ARNs",
            maximum=5,
        ),
        "rollbackConfiguration": normalized_rollback_configuration(
            payload.get("RollbackConfiguration"),
            label="change-set",
        ),
        "tags": normalized_tags(payload.get("Tags"), label="change-set"),
    }
    for key in ("notificationArns", "tags"):
        if desired_controls[key] != current_controls[key]:
            fail(f"change set alters the stack-level {key} control")
    if (
        desired_controls["rollbackConfiguration"]
        != expected_rollback_configuration
    ):
        fail("change set rollback configuration is not the exact activation control")

    # DescribeChangeSet omits the execution role on some API versions. When
    # that field is available, it must equal the exact existing stack role.
    if "RoleARN" in payload and normalized_role_arn(
        payload.get("RoleARN"),
        label="change-set",
    ) != current_controls["executionRoleArn"]:
        fail("change set alters the stack execution role")
    on_stack_failure = payload.get("OnStackFailure")
    if on_stack_failure is not None and on_stack_failure != "":
        fail("UPDATE activation change set must not set OnStackFailure")
    import_existing = payload.get("ImportExistingResources")
    if import_existing is not None and import_existing is not False:
        fail("activation change set must not import existing resources")
    deployment_mode = payload.get("DeploymentMode")
    if deployment_mode is not None and deployment_mode != "":
        fail("activation change set must not use drift-revert deployment mode")
    disable_rollback = payload.get("DisableRollback")
    if disable_rollback is not None and disable_rollback is not False:
        fail("activation change set must preserve rollback")
    deployment = payload.get("DeploymentConfig")
    if deployment is not None:
        if not isinstance(deployment, dict) or not set(deployment).issubset(
            {"Mode", "DisableRollback"},
        ):
            fail("activation change set deployment configuration is invalid")
        if (
            deployment.get("Mode", "STANDARD") != "STANDARD"
            or deployment.get("DisableRollback", False) is not False
        ):
            fail("activation change set must use standard rollback-enabled deployment")
    return {
        **current_controls,
        "rollbackConfiguration": expected_rollback_configuration,
    }


class AwsCli:
    def __init__(
        self,
        *,
        binary: Path,
        config: Path,
        profile: str,
        region: str,
        command_timeout: int,
        wait_timeout: int,
    ) -> None:
        self.binary = binary
        self.region = region
        self.command_timeout = command_timeout
        self.wait_timeout = wait_timeout
        self.environment = {
            "HOME": str(config.parent),
            "PATH": f"{binary.parent}:/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "AWS_CONFIG_FILE": str(config),
            "AWS_PROFILE": profile,
            "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_REGION": region,
            "AWS_DEFAULT_REGION": region,
            "AWS_PAGER": "",
            "AWS_CLI_AUTO_PROMPT": "off",
            "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true",
        }

    def _command(self, arguments: list[str]) -> list[str]:
        return [
            str(self.binary),
            *arguments,
            "--region",
            self.region,
            "--no-cli-pager",
            "--cli-connect-timeout",
            "10",
            "--cli-read-timeout",
            "60",
        ]

    def run(
        self,
        arguments: list[str],
        *,
        expect_json: bool,
        wait: bool = False,
    ) -> Any:
        timeout = self.wait_timeout if wait else self.command_timeout
        try:
            result = subprocess.run(
                self._command(arguments),
                check=False,
                capture_output=True,
                env=self.environment,
                timeout=timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            fail(f"AWS CLI command did not complete: {' '.join(arguments[:2])}: {error}")
        if len(result.stdout) > MAX_JSON_BYTES or len(result.stderr) > MAX_JSON_BYTES:
            fail(f"AWS CLI command returned oversized output: {' '.join(arguments[:2])}")
        if result.returncode != 0:
            stderr_sha = sha256_bytes(result.stderr)
            fail(
                "AWS CLI command failed: "
                f"{' '.join(arguments[:2])} exit={result.returncode} "
                f"stderrSha256={stderr_sha}",
            )
        if not expect_json:
            return None
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            fail(f"AWS CLI command returned invalid JSON: {' '.join(arguments[:2])}: {error}")
        if not isinstance(payload, dict):
            fail(f"AWS CLI command returned a non-object: {' '.join(arguments[:2])}")
        return payload


def alarm_name(alarm_arn: str) -> str:
    matched = CLOUDWATCH_ALARM_ARN.fullmatch(alarm_arn)
    if matched is None:
        fail("activation rollback alarm ARN is invalid")
    return matched.group(4)


def metric_dimensions(value: Any, *, label: str) -> dict[str, str]:
    if not isinstance(value, list) or len(value) != 1:
        fail(f"{label} dimensions are invalid")
    dimensions: dict[str, str] = {}
    for entry in value:
        if (
            not isinstance(entry, dict)
            or set(entry) != {"Name", "Value"}
            or not isinstance(entry.get("Name"), str)
            or not isinstance(entry.get("Value"), str)
            or entry["Name"] in dimensions
        ):
            fail(f"{label} dimensions are invalid")
        dimensions[entry["Name"]] = entry["Value"]
    if set(dimensions) != {"StackName"}:
        fail(f"{label} dimensions are invalid")
    return dimensions


def describe_activation_alarm(
    cli: AwsCli,
    *,
    alarm_arn: str,
    stack_name: str,
) -> dict[str, str]:
    payload = cli.run(
        [
            "cloudwatch",
            "describe-alarms",
            "--alarm-names",
            alarm_name(alarm_arn),
            "--output",
            "json",
        ],
        expect_json=True,
    )
    alarms = payload.get("MetricAlarms")
    if (
        payload.get("NextToken") not in {None, ""}
        or not isinstance(alarms, list)
        or len(alarms) != 1
        or not isinstance(alarms[0], dict)
    ):
        fail("CloudWatch did not return the exact activation rollback alarm")
    alarm = alarms[0]
    if (
        alarm.get("AlarmArn") != alarm_arn
        or alarm.get("AlarmName") != alarm_name(alarm_arn)
        or alarm.get("ComparisonOperator") != "LessThanThreshold"
        or alarm.get("DatapointsToAlarm")
        != ACTIVATION_ALARM_EVALUATION_PERIODS
        or alarm.get("EvaluationPeriods")
        != ACTIVATION_ALARM_EVALUATION_PERIODS
        or alarm.get("Threshold") != 1
        or alarm.get("TreatMissingData") != "breaching"
        or alarm.get("MetricName") != ACTIVATION_LEASE_METRIC
        or alarm.get("Namespace") != ACTIVATION_METRIC_NAMESPACE
        or alarm.get("Period") != ACTIVATION_ALARM_PERIOD_SECONDS
        or alarm.get("Statistic") != "Minimum"
        or alarm.get("Unit") != "Count"
    ):
        fail("activation rollback alarm controls differ from the reviewed template")
    dimensions = metric_dimensions(
        alarm.get("Dimensions"),
        label="activation rollback alarm",
    )
    if dimensions.get("StackName") != stack_name:
        fail("activation rollback alarm stack dimension is invalid")
    state = alarm.get("StateValue")
    if state not in {"OK", "ALARM", "INSUFFICIENT_DATA"}:
        fail("activation rollback alarm state is invalid")
    return {
        "alarmArn": alarm_arn,
        "state": state,
    }


def publish_activation_metric(
    cli: AwsCli,
    *,
    stack_name: str,
) -> None:
    metric = [{
        "MetricName": ACTIVATION_LEASE_METRIC,
        "Dimensions": [
            {"Name": "StackName", "Value": stack_name},
        ],
        "Value": 1,
        "Unit": "Count",
        "StorageResolution": 1,
    }]
    cli.run(
        [
            "cloudwatch",
            "put-metric-data",
            "--namespace",
            ACTIVATION_METRIC_NAMESPACE,
            "--metric-data",
            canonical_json(metric).decode("utf-8"),
        ],
        expect_json=False,
    )


def activation_lease_budget() -> dict[str, int]:
    alarm_window = (
        ACTIVATION_ALARM_EVALUATION_PERIODS
        * ACTIVATION_ALARM_PERIOD_SECONDS
    )
    aws_chunk = (
        MAX_VALIDATED_AWS_CALLS_BETWEEN_LEASE_RENEWALS
        * MAX_AWS_COMMAND_SECONDS
    )
    external_chunk = max(MAX_CRL_VERIFY_SECONDS, MAX_PROBE_SECONDS)
    worst_chunk = max(aws_chunk, external_chunk)
    margin = alarm_window - worst_chunk
    if margin < ACTIVATION_LEASE_REQUIRED_MARGIN_SECONDS:
        fail("activation rollback lease has insufficient bounded safety margin")
    return {
        "alarmWindowSeconds": alarm_window,
        "maxAwsCommandSeconds": MAX_AWS_COMMAND_SECONDS,
        "maxValidatedAwsCallsBetweenRenewals": (
            MAX_VALIDATED_AWS_CALLS_BETWEEN_LEASE_RENEWALS
        ),
        "maxValidatedAwsChunkSeconds": aws_chunk,
        "maxExternalVerifierChunkSeconds": external_chunk,
        "minimumSafetyMarginSeconds": margin,
    }


def require_idle_activation_alarm(
    cli: AwsCli,
    *,
    alarm_arn: str,
    stack_name: str,
) -> dict[str, str]:
    alarm = describe_activation_alarm(
        cli,
        alarm_arn=alarm_arn,
        stack_name=stack_name,
    )
    if alarm["state"] != "ALARM":
        fail(
            "activation rollback alarm must age to ALARM before inspection "
            "or execution",
        )
    return alarm


def prime_activation_alarm(
    cli: AwsCli,
    *,
    alarm_arn: str,
    stack_name: str,
    timeout_seconds: int,
    poll_seconds: int,
) -> dict[str, str]:
    deadline = time.monotonic() + timeout_seconds
    while True:
        publish_activation_metric(
            cli,
            stack_name=stack_name,
        )
        alarm = describe_activation_alarm(
            cli,
            alarm_arn=alarm_arn,
            stack_name=stack_name,
        )
        if alarm["state"] == "OK":
            return alarm
        if time.monotonic() >= deadline:
            fail("activation rollback alarm did not become OK before execution")
        time.sleep(poll_seconds)


def load_probe_arguments(
    path: Path,
    expected_sha256: str,
) -> list[str]:
    try:
        body = path.read_bytes()
    except OSError as error:
        fail(f"post-enable probe argument file is unreadable: {error}")
    if len(body) > 256 * 1024 or sha256_bytes(body) != expected_sha256:
        fail("post-enable probe argument file differs from its approved SHA-256")
    try:
        value = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"post-enable probe argument file is invalid JSON: {error}")
    if (
        not isinstance(value, list)
        or not 1 <= len(value) <= 64
        or any(
            not isinstance(entry, str)
            or not entry
            or len(entry) > 4096
            or "\x00" in entry
            for entry in value
        )
    ):
        fail("post-enable probe arguments are invalid")
    return value


CRL_VERIFY_VALUE_FLAGS = {
    "--region",
    "--trust-anchor-arn",
    "--backup-profile-arn",
    "--restore-profile-arn",
    "--crl-id",
    "--name",
    "--expected-enabled",
    "--issuer-cn",
    "--ca-certificate",
    "--crl",
    "--parameter-evidence",
    "--aws-profile",
    "--evidence-out",
}


def validate_crl_verifier_arguments(
    arguments: list[str],
    *,
    identity: dict[str, str],
    stack_name: str,
    region: str,
    aws_profile: str,
    evidence_path: Path,
) -> dict[str, str]:
    if not arguments or arguments[0] != "verify":
        fail("post-enable CRL verifier must use the read-only verify operation")
    parsed: dict[str, str] = {}
    index = 1
    while index < len(arguments):
        flag = arguments[index]
        if (
            flag not in CRL_VERIFY_VALUE_FLAGS
            or flag in parsed
            or index + 1 >= len(arguments)
        ):
            fail("post-enable CRL verifier arguments exceed the exact allowlist")
        parsed[flag] = arguments[index + 1]
        index += 2
    if set(parsed) != CRL_VERIFY_VALUE_FLAGS:
        fail("post-enable CRL verifier arguments are incomplete")
    expected = {
        "--region": region,
        "--trust-anchor-arn": identity["trustAnchorArn"],
        "--backup-profile-arn": identity["backupProfileArn"],
        "--restore-profile-arn": identity["restoreProfileArn"],
        "--crl-id": identity["crlId"],
        "--name": f"{stack_name}-crl",
        "--expected-enabled": "true",
        "--aws-profile": aws_profile,
        "--evidence-out": str(evidence_path),
    }
    for flag, value in expected.items():
        if parsed.get(flag) != value:
            fail(f"post-enable CRL verifier differs from exact {flag}")
    return parsed


def validate_crl_live_evidence(
    path: Path,
    *,
    expected_sha256: str | None,
    identity: dict[str, str],
    region: str,
    owner_uid: int,
    boundary: Path,
) -> dict[str, Any]:
    private_file(
        path,
        label="post-enable live CRL evidence",
        owner_uid=owner_uid,
        boundary=boundary,
    )
    try:
        body = path.read_bytes()
    except OSError as error:
        fail(f"post-enable live CRL evidence is unreadable: {error}")
    digest = sha256_bytes(body)
    if expected_sha256 is not None and digest != expected_sha256:
        fail("post-enable live CRL evidence changed after validation")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"post-enable live CRL evidence is invalid JSON: {error}")
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != CRL_LIVE_SCHEMA
        or payload.get("region") != region
        or payload.get("trustAnchorArn") != identity["trustAnchorArn"]
        or payload.get("trustAnchorEnabled") is not True
        or payload.get("backupProfileArn") != identity["backupProfileArn"]
        or payload.get("backupProfileEnabled") is not True
        or payload.get("restoreProfileArn") != identity["restoreProfileArn"]
        or payload.get("restoreProfileEnabled") is not True
        or payload.get("crlId") != identity["crlId"]
        or payload.get("crlEnabled") is not True
        or payload.get("exactBytesVerified") is not True
        or payload.get("digestTagVerified") is not True
    ):
        fail("post-enable live CRL evidence is not exact")
    verified_at = payload.get("verifiedAt")
    if not isinstance(verified_at, str) or not verified_at.endswith("Z"):
        fail("post-enable live CRL evidence time is invalid")
    try:
        observed = datetime.fromisoformat(verified_at[:-1] + "+00:00")
    except ValueError:
        fail("post-enable live CRL evidence time is invalid")
    age = datetime.now(timezone.utc) - observed.astimezone(timezone.utc)
    if age.total_seconds() < -300 or age.total_seconds() > 40 * 60:
        fail("post-enable live CRL evidence is stale or future-dated")
    return {"sha256": digest, "payload": payload}


def run_post_enable_crl_verifier(
    *,
    executable: Path,
    arguments: list[str],
    evidence_path: Path,
    identity: dict[str, str],
    region: str,
    owner_uid: int,
    boundary: Path,
    environment: dict[str, str],
) -> dict[str, Any]:
    if evidence_path.exists():
        return validate_crl_live_evidence(
            evidence_path,
            expected_sha256=None,
            identity=identity,
            region=region,
            owner_uid=owner_uid,
            boundary=boundary,
        )
    private_output_parent(
        evidence_path,
        owner_uid=owner_uid,
        boundary=boundary,
    )
    try:
        result = subprocess.run(
            [str(executable), *arguments],
            check=False,
            capture_output=True,
            env=environment,
            stdin=subprocess.DEVNULL,
            timeout=MAX_CRL_VERIFY_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"post-enable live CRL verifier did not complete: {error}")
    if (
        len(result.stdout) > 256 * 1024
        or len(result.stderr) > 256 * 1024
        or result.returncode != 0
    ):
        fail(
            "post-enable live CRL verifier failed "
            f"exit={result.returncode} stderrSha256={sha256_bytes(result.stderr)}",
        )
    try:
        summary = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail("post-enable live CRL verifier returned invalid JSON")
    if (
        not isinstance(summary, dict)
        or summary.get("ok") is not True
        or summary.get("crlEnabled") is not True
        or summary.get("exactBytesVerified") is not True
    ):
        fail("post-enable live CRL verifier returned invalid status")
    return validate_crl_live_evidence(
        evidence_path,
        expected_sha256=None,
        identity=identity,
        region=region,
        owner_uid=owner_uid,
        boundary=boundary,
    )


PROBE_VALUE_FLAGS = {
    "--positive-config",
    "--positive-profile",
    "--revoked-config",
    "--revoked-profile",
    "--region",
    "--expected-role-arn",
    "--expected-trust-anchor-arn",
    "--expected-profile-arn",
    "--expected-bucket",
    "--expected-prefix",
    "--expected-positive-certificate-sha256",
    "--expected-revoked-certificate-sha256",
    "--ca-certificate",
    "--crl",
    "--live-crl-evidence",
    "--aws-bin",
    "--openssl-bin",
    "--python-bin",
    "--boundary-helper",
    "--signing-helper",
    "--signing-helper-sha256",
    "--output",
    "--expected-owner-uid",
    "--trust-boundary",
}


def validate_probe_arguments(
    arguments: list[str],
    *,
    identity: dict[str, str],
    region: str,
    aws_binary: Path,
    evidence_path: Path,
    live_crl_evidence_path: Path,
    owner_uid: int,
    trust_boundary: Path,
) -> dict[str, str]:
    parsed: dict[str, str] = {}
    index = 0
    while index < len(arguments):
        flag = arguments[index]
        if (
            flag not in PROBE_VALUE_FLAGS
            or flag in parsed
            or index + 1 >= len(arguments)
        ):
            fail("post-enable probe arguments exceed the exact allowlist")
        parsed[flag] = arguments[index + 1]
        index += 2
    if set(parsed) != PROBE_VALUE_FLAGS:
        fail("post-enable probe arguments are incomplete")
    expected = {
        "--region": region,
        "--expected-role-arn": identity["backupRoleArn"],
        "--expected-trust-anchor-arn": identity["trustAnchorArn"],
        "--expected-profile-arn": identity["backupProfileArn"],
        "--expected-bucket": identity["bucket"],
        "--expected-prefix": identity["prefix"],
        "--aws-bin": str(aws_binary),
        "--live-crl-evidence": str(live_crl_evidence_path),
        "--output": str(evidence_path),
        "--expected-owner-uid": str(owner_uid),
        "--trust-boundary": str(trust_boundary),
    }
    for flag, value in expected.items():
        if parsed.get(flag) != value:
            fail(f"post-enable probe differs from exact {flag}")
    return parsed


def validate_probe_evidence(
    path: Path,
    *,
    expected_sha256: str | None,
    identity: dict[str, str],
    region: str,
    owner_uid: int,
    boundary: Path,
) -> dict[str, Any]:
    private_file(
        path,
        label="post-enable probe evidence",
        owner_uid=owner_uid,
        boundary=boundary,
    )
    try:
        body = path.read_bytes()
    except OSError as error:
        fail(f"post-enable probe evidence is unreadable: {error}")
    digest = sha256_bytes(body)
    if expected_sha256 is not None and digest != expected_sha256:
        fail("post-enable probe evidence changed after validation")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"post-enable probe evidence is invalid JSON: {error}")
    binding = payload.get("identityBinding") if isinstance(payload, dict) else None
    positive = payload.get("positive") if isinstance(payload, dict) else None
    revoked = payload.get("revoked") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or payload.get("schemaVersion") != PROBE_SCHEMA
        or payload.get("status") != "passed"
        or payload.get("region") != region
        or payload.get("credentialsPersisted") is not False
        or payload.get("longLivedCredentialsAccepted") is not False
        or not isinstance(binding, dict)
        or binding.get("expectedRoleArnSha256")
        != sha256_bytes(identity["backupRoleArn"].encode())
        or binding.get("trustAnchorArnSha256")
        != sha256_bytes(identity["trustAnchorArn"].encode())
        or binding.get("profileArnSha256")
        != sha256_bytes(identity["backupProfileArn"].encode())
        or not isinstance(positive, dict)
        or positive.get("prefixListAuthorized") is not True
        or not isinstance(revoked, dict)
        or revoked.get("credentialIssuanceDenied") is not True
        or revoked.get("localCrlRevocationVerified") is not True
    ):
        fail("post-enable positive/revoked probe evidence is not exact")
    observed_at = payload.get("observedAt")
    if not isinstance(observed_at, str) or not observed_at.endswith("Z"):
        fail("post-enable probe evidence time is invalid")
    try:
        observed = datetime.fromisoformat(observed_at[:-1] + "+00:00")
    except ValueError:
        fail("post-enable probe evidence time is invalid")
    age = datetime.now(timezone.utc) - observed.astimezone(timezone.utc)
    if age.total_seconds() < -300 or age.total_seconds() > 40 * 60:
        fail("post-enable probe evidence is stale or future-dated")
    return {"sha256": digest, "payload": payload}


def run_post_enable_probe(
    *,
    executable: Path,
    arguments: list[str],
    evidence_path: Path,
    identity: dict[str, str],
    region: str,
    owner_uid: int,
    boundary: Path,
) -> dict[str, Any]:
    if evidence_path.exists():
        return validate_probe_evidence(
            evidence_path,
            expected_sha256=None,
            identity=identity,
            region=region,
            owner_uid=owner_uid,
            boundary=boundary,
        )
    private_output_parent(
        evidence_path,
        owner_uid=owner_uid,
        boundary=boundary,
    )
    environment = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/nonexistent",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    try:
        result = subprocess.run(
            [str(executable), *arguments],
            check=False,
            capture_output=True,
            env=environment,
            stdin=subprocess.DEVNULL,
            timeout=MAX_PROBE_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"post-enable positive/revoked probe did not complete: {error}")
    if (
        len(result.stdout) > 256 * 1024
        or len(result.stderr) > 256 * 1024
        or result.returncode != 0
    ):
        fail(
            "post-enable positive/revoked probe failed "
            f"exit={result.returncode} stderrSha256={sha256_bytes(result.stderr)}",
        )
    try:
        summary = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail("post-enable positive/revoked probe returned invalid JSON")
    if (
        not isinstance(summary, dict)
        or summary.get("ok") is not True
        or summary.get("schemaVersion") != PROBE_SCHEMA
        or summary.get("status") != "passed"
        or not isinstance(summary.get("evidenceSha256"), str)
        or SHA256.fullmatch(summary["evidenceSha256"]) is None
    ):
        fail("post-enable positive/revoked probe returned invalid status")
    evidence = validate_probe_evidence(
        evidence_path,
        expected_sha256=summary.get("evidenceSha256"),
        identity=identity,
        region=region,
        owner_uid=owner_uid,
        boundary=boundary,
    )
    return evidence


def template_sha256(
    cli: AwsCli,
    *,
    stack_id: str,
    change_set_id: str | None = None,
) -> str:
    arguments = [
        "cloudformation",
        "get-template",
        "--stack-name",
        stack_id,
        "--template-stage",
        "Original",
        "--output",
        "json",
    ]
    if change_set_id is not None:
        arguments.extend(["--change-set-name", change_set_id])
    payload = cli.run(arguments, expect_json=True)
    if "TemplateBody" not in payload:
        fail("CloudFormation get-template omitted TemplateBody")
    body = payload["TemplateBody"]
    if isinstance(body, str):
        encoded = body.encode("utf-8")
    elif isinstance(body, (dict, list)):
        encoded = canonical_json(body)
    else:
        fail("CloudFormation TemplateBody has an unsupported shape")
    return sha256_bytes(encoded)


def describe_stack(cli: AwsCli, stack_id: str) -> dict[str, Any]:
    payload = cli.run(
        [
            "cloudformation",
            "describe-stacks",
            "--stack-name",
            stack_id,
            "--output",
            "json",
        ],
        expect_json=True,
    )
    if payload.get("NextToken") not in {None, ""}:
        fail("CloudFormation describe-stacks response is unexpectedly paginated")
    stacks = payload.get("Stacks")
    if not isinstance(stacks, list) or len(stacks) != 1:
        fail("CloudFormation describe-stacks did not return exactly one stack")
    stack = stacks[0]
    if not isinstance(stack, dict) or stack.get("StackId") != stack_id:
        fail("CloudFormation returned a different stack identity")
    status = stack.get("StackStatus")
    if not isinstance(status, str):
        fail("CloudFormation stack status is invalid")
    return {
        "stackId": stack_id,
        "stackStatus": status,
        "parameters": normalized_parameters(
            stack.get("Parameters"),
            label="stack",
        ),
        "outputs": normalized_outputs(stack.get("Outputs")),
        "controls": normalized_stack_controls(stack),
    }


def matching_ra_arn(
    value: str,
    *,
    kind: str,
    partition: str,
    region: str,
    account: str,
    label: str,
) -> str:
    matched = ROLES_ANYWHERE_ARN.fullmatch(value)
    if (
        matched is None
        or matched.group(1) != partition
        or matched.group(2) != region
        or matched.group(3) != account
        or matched.group(4) != kind
    ):
        fail(f"{label} is not the exact expected Roles Anywhere ARN")
    return matched.group(5)


def matching_role_arn(
    value: str,
    *,
    partition: str,
    account: str,
    label: str,
) -> None:
    matched = IAM_ROLE_ARN.fullmatch(value)
    if (
        matched is None
        or matched.group(1) != partition
        or matched.group(2) != account
    ):
        fail(f"{label} is not an exact in-account IAM role ARN")


def validate_stack_phase(
    stack: dict[str, Any],
    *,
    transition: str,
    final: bool,
    bootstrap_receipt_sha256: str | None,
    partition: str,
    region: str,
    account: str,
    expected_parameters: list[dict[str, str]] | None = None,
    expected_controls: dict[str, Any] | None = None,
    allowed_statuses: set[str] | None = None,
) -> dict[str, str]:
    expected_statuses = (
        allowed_statuses
        if allowed_statuses is not None
        else ({"UPDATE_COMPLETE"} if final else COMPLETED_STACK_STATUSES)
    )
    if stack["stackStatus"] not in expected_statuses:
        fail(
            "stack is not in the required completed "
            f"{'final' if final else 'current'} phase",
        )
    parameters = parameter_map(stack["parameters"])
    if transition == "roles-anywhere":
        roles_activation = "ENABLED" if final else "DISABLED"
        lifecycle_activation = "DISABLED"
        lifecycle_receipt = ""
    else:
        roles_activation = "ENABLED"
        lifecycle_activation = "ENABLED" if final else "DISABLED"
        lifecycle_receipt = bootstrap_receipt_sha256 if final else ""
    required_parameters = {
        "PrincipalProvisioningMode": "IAM_ROLES_ANYWHERE",
        "RolesAnywhereActivation": roles_activation,
        "LifecycleActivation": lifecycle_activation,
        "LifecycleBootstrapReceiptSha256": lifecycle_receipt,
    }
    for key, expected in required_parameters.items():
        if parameters.get(key) != expected:
            fail(f"stack parameter {key} does not match the required activation phase")
    if "PriorDisabledStackId" in parameters:
        fail("legacy PriorDisabledStackId claims are not accepted as activation proof")
    if expected_parameters is not None and stack["parameters"] != expected_parameters:
        fail("enabled stack parameters differ from the reviewed change set")
    if expected_controls is not None and stack["controls"] != expected_controls:
        fail("enabled stack-level controls differ from the reviewed current stack")
    outputs = stack["outputs"]
    if outputs["RolesAnywhereActivation"] != roles_activation:
        fail("RolesAnywhereActivation output does not match the required phase")
    if outputs["LifecycleActivation"] != lifecycle_activation:
        fail("LifecycleActivation output does not match the required phase")
    if outputs["LifecycleBootstrapReceiptSha256"] != lifecycle_receipt:
        fail("lifecycle receipt output does not match the required phase")
    matching_role_arn(
        outputs["BackupPrincipalArn"],
        partition=partition,
        account=account,
        label="backup principal",
    )
    matching_role_arn(
        outputs["RestorePrincipalArn"],
        partition=partition,
        account=account,
        label="restore principal",
    )
    trust_anchor_id = matching_ra_arn(
        outputs["RolesAnywhereTrustAnchorArn"],
        kind="trust-anchor",
        partition=partition,
        region=region,
        account=account,
        label="trust anchor output",
    )
    backup_profile_id = matching_ra_arn(
        outputs["BackupRolesAnywhereProfileArn"],
        kind="profile",
        partition=partition,
        region=region,
        account=account,
        label="backup profile output",
    )
    restore_profile_id = matching_ra_arn(
        outputs["RestoreRolesAnywhereProfileArn"],
        kind="profile",
        partition=partition,
        region=region,
        account=account,
        label="restore profile output",
    )
    if not CRL_ID.fullmatch(outputs["RolesAnywhereCrlId"]):
        fail("CRL output is not an exact identifier")
    alarm_match = CLOUDWATCH_ALARM_ARN.fullmatch(
        outputs["RolesAnywhereActivationRollbackAlarmArn"],
    )
    if (
        alarm_match is None
        or alarm_match.group(1) != partition
        or alarm_match.group(2) != region
        or alarm_match.group(3) != account
    ):
        fail("activation rollback alarm output is not the exact in-account ARN")
    bucket = outputs["BucketName"]
    prefix = outputs["DrPrefix"]
    if (
        not isinstance(bucket, str)
        or not bucket
        or not isinstance(prefix, str)
        or not prefix
    ):
        fail("bucket and DR prefix outputs must be non-empty")
    return {
        "bucket": bucket,
        "prefix": prefix,
        "trustAnchorId": trust_anchor_id,
        "trustAnchorArn": outputs["RolesAnywhereTrustAnchorArn"],
        "crlId": outputs["RolesAnywhereCrlId"],
        "backupProfileId": backup_profile_id,
        "backupProfileArn": outputs["BackupRolesAnywhereProfileArn"],
        "restoreProfileId": restore_profile_id,
        "restoreProfileArn": outputs["RestoreRolesAnywhereProfileArn"],
        "backupRoleArn": outputs["BackupPrincipalArn"],
        "restoreRoleArn": outputs["RestorePrincipalArn"],
        "rollbackAlarmArn": outputs[
            "RolesAnywhereActivationRollbackAlarmArn"
        ],
    }


def lifecycle_state(
    cli: AwsCli,
    *,
    bucket: str,
    prefix: str,
    enabled: bool,
) -> dict[str, Any]:
    payload = cli.run(
        [
            "s3api",
            "get-bucket-lifecycle-configuration",
            "--bucket",
            bucket,
            "--output",
            "json",
        ],
        expect_json=True,
    )
    rules = payload.get("Rules")
    if not isinstance(rules, list) or len(rules) != 6:
        fail("live S3 Lifecycle does not contain the exact six governed rules")
    expected = {
        "GovernedNamespaceHygiene": {
            "prefix": f"{prefix}/",
            "status": "Enabled",
            "properties": {
                "AbortIncompleteMultipartUpload": {
                    "DaysAfterInitiation": 7,
                },
                "ExpiredObjectDeleteMarker": True,
            },
        },
        "DatabaseHourlyWriteOnceRetention": (
            f"{prefix}/database/hourly/",
            3,
        ),
        "DatabaseDailyWriteOnceRetention": (
            f"{prefix}/database/daily/",
            9,
        ),
        "DatabaseWeeklyWriteOnceRetention": (
            f"{prefix}/database/weekly/",
            36,
        ),
        "DatabaseMonthlyWriteOnceRetention": (
            f"{prefix}/database/monthly/",
            191,
        ),
        "ReleaseWriteOnceRetention": (
            f"{prefix}/releases/",
            92,
        ),
    }
    for rule_id, rule_value in list(expected.items()):
        if rule_id == "GovernedNamespaceHygiene":
            continue
        rule_prefix, expiration_days = rule_value
        expected[rule_id] = {
            "prefix": rule_prefix,
            "status": "Enabled" if enabled else "Disabled",
            "properties": {
                "Expiration": {"Days": expiration_days},
                "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
            },
        }
    normalized: dict[str, dict[str, str]] = {}
    for rule in rules:
        if not isinstance(rule, dict):
            fail("live S3 Lifecycle contains an invalid rule")
        working = dict(rule)
        rule_id = working.pop("ID", working.pop("Id", None))
        status_value = working.pop("Status", None)
        rule_prefix = working.pop("Prefix", None)
        if rule_prefix is None:
            lifecycle_filter = working.pop("Filter", None)
            if (
                not isinstance(lifecycle_filter, dict)
                or set(lifecycle_filter) != {"Prefix"}
            ):
                fail("live S3 Lifecycle rule filter is not an exact prefix")
            rule_prefix = lifecycle_filter["Prefix"]
        expected_rule = expected.get(rule_id)
        if (
            not isinstance(rule_id, str)
            or rule_id in normalized
            or not isinstance(expected_rule, dict)
            or rule_prefix != expected_rule["prefix"]
            or status_value != expected_rule["status"]
            or working != expected_rule["properties"]
        ):
            fail("live S3 Lifecycle identity or activation state differs")
        normalized[rule_id] = {
            "prefix": rule_prefix,
            "status": status_value,
        }
    if set(normalized) != set(expected):
        fail("live S3 Lifecycle governed rule set is incomplete")
    return {
        key: normalized[key]
        for key in sorted(normalized)
    }


def roles_anywhere_state(
    cli: AwsCli,
    *,
    identity: dict[str, str],
    enabled: bool | None,
) -> dict[str, Any]:
    trust_payload = cli.run(
        [
            "rolesanywhere",
            "get-trust-anchor",
            "--trust-anchor-id",
            identity["trustAnchorId"],
            "--output",
            "json",
        ],
        expect_json=True,
    )
    crl_payload = cli.run(
        [
            "rolesanywhere",
            "get-crl",
            "--crl-id",
            identity["crlId"],
            "--output",
            "json",
        ],
        expect_json=True,
    )
    profile_payloads = []
    for profile_id in (
        identity["backupProfileId"],
        identity["restoreProfileId"],
    ):
        profile_payloads.append(
            cli.run(
                [
                    "rolesanywhere",
                    "get-profile",
                    "--profile-id",
                    profile_id,
                    "--output",
                    "json",
                ],
                expect_json=True,
            ),
        )
    trust = trust_payload.get("trustAnchor")
    crl = crl_payload.get("crl")
    profiles = [payload.get("profile") for payload in profile_payloads]
    if not isinstance(trust, dict) or not isinstance(crl, dict):
        fail("Roles Anywhere returned invalid trust-anchor or CRL state")
    if (
        trust.get("trustAnchorId") != identity["trustAnchorId"]
        or trust.get("trustAnchorArn") != identity["trustAnchorArn"]
        or not isinstance(trust.get("enabled"), bool)
        or (enabled is not None and trust.get("enabled") is not enabled)
    ):
        fail("live Roles Anywhere trust anchor differs from the required phase")
    if (
        crl.get("crlId") != identity["crlId"]
        or crl.get("trustAnchorArn") != identity["trustAnchorArn"]
        or not isinstance(crl.get("enabled"), bool)
        or (enabled is not None and crl.get("enabled") is not enabled)
    ):
        fail("live Roles Anywhere CRL differs from the required phase")
    expected_profiles = (
        (
            identity["backupProfileId"],
            identity["backupProfileArn"],
            identity["backupRoleArn"],
        ),
        (
            identity["restoreProfileId"],
            identity["restoreProfileArn"],
            identity["restoreRoleArn"],
        ),
    )
    normalized_profiles = []
    for profile, expected in zip(profiles, expected_profiles, strict=True):
        profile_id, profile_arn, role_arn = expected
        if (
            not isinstance(profile, dict)
            or profile.get("profileId") != profile_id
            or profile.get("profileArn") != profile_arn
            or not isinstance(profile.get("enabled"), bool)
            or (enabled is not None and profile.get("enabled") is not enabled)
            or profile.get("roleArns") != [role_arn]
            or profile.get("acceptRoleSessionName") is not False
            or profile.get("durationSeconds") != 900
        ):
            fail("live Roles Anywhere profile differs from the required phase")
        normalized_profiles.append(
            {
                "profileId": profile_id,
                "profileArn": profile_arn,
                "roleArn": role_arn,
                "enabled": profile["enabled"],
            },
        )
    enabled_values = [
        trust["enabled"],
        crl["enabled"],
        *(profile["enabled"] for profile in profiles),
    ]
    return {
        "trustAnchor": {
            "trustAnchorId": identity["trustAnchorId"],
            "trustAnchorArn": identity["trustAnchorArn"],
            "enabled": trust["enabled"],
        },
        "crl": {
            "crlId": identity["crlId"],
            "trustAnchorArn": identity["trustAnchorArn"],
            "enabled": crl["enabled"],
        },
        "profiles": normalized_profiles,
        "allEnabled": all(enabled_values),
        "allDisabled": not any(enabled_values),
    }


def observe_phase(
    cli: AwsCli,
    *,
    stack_id: str,
    template_digest: str,
    transition: str,
    final: bool,
    bootstrap_receipt_sha256: str | None,
    partition: str,
    region: str,
    account: str,
    expected_parameters: list[dict[str, str]] | None = None,
    expected_controls: dict[str, Any] | None = None,
    allowed_statuses: set[str] | None = None,
) -> dict[str, Any]:
    stack = describe_stack(cli, stack_id)
    identity = validate_stack_phase(
        stack,
        transition=transition,
        final=final,
        bootstrap_receipt_sha256=bootstrap_receipt_sha256,
        partition=partition,
        region=region,
        account=account,
        expected_parameters=expected_parameters,
        expected_controls=expected_controls,
        allowed_statuses=allowed_statuses,
    )
    observed_template_digest = template_sha256(cli, stack_id=stack_id)
    if observed_template_digest != template_digest:
        fail("deployed stack template differs from the exact reviewed template")
    live_state = roles_anywhere_state(
        cli,
        identity=identity,
        enabled=final if transition == "roles-anywhere" else True,
    )
    live_lifecycle = lifecycle_state(
        cli,
        bucket=identity["bucket"],
        prefix=identity["prefix"],
        enabled=final if transition == "lifecycle" else False,
    )
    return {
        "stack": stack,
        "identity": identity,
        "templateSha256": observed_template_digest,
        "liveRolesAnywhereState": live_state,
        "liveLifecycleState": live_lifecycle,
    }


def describe_change_set(
    cli: AwsCli,
    *,
    stack_id: str,
    change_set_id: str,
) -> dict[str, Any]:
    payload = cli.run(
        [
            "cloudformation",
            "describe-change-set",
            "--stack-name",
            stack_id,
            "--change-set-name",
            change_set_id,
            "--include-property-values",
            "--output",
            "json",
        ],
        expect_json=True,
    )
    if payload.get("NextToken") not in {None, ""}:
        fail("reviewed change set is paginated and therefore incomplete")
    return payload


def recovery_change_set_status(
    live: dict[str, Any],
    reviewed: dict[str, Any],
) -> str:
    execution_status = live.get("ExecutionStatus")
    if execution_status not in {
        "AVAILABLE",
        "EXECUTE_IN_PROGRESS",
        "EXECUTE_COMPLETE",
    }:
        fail("recovery change-set execution state is unsupported")
    if reviewed.get("ExecutionStatus") != "AVAILABLE":
        fail("reviewed change-set execution state is invalid")
    normalized = dict(live)
    normalized["ExecutionStatus"] = "AVAILABLE"
    if canonical_json(normalized) != canonical_json(reviewed):
        fail("recovery change set differs from the exact reviewed operation")
    return execution_status


def validate_change_set(
    payload: dict[str, Any],
    *,
    stack_id: str,
    change_set_id: str,
    transition: str,
    current_parameters: list[dict[str, str]],
    current_controls: dict[str, Any],
    current_identity: dict[str, str],
    bootstrap_receipt_sha256: str | None,
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    if (
        payload.get("StackId") != stack_id
        or payload.get("ChangeSetId") != change_set_id
        or payload.get("ChangeSetType") != "UPDATE"
        or payload.get("Status") != "CREATE_COMPLETE"
        or payload.get("ExecutionStatus") != "AVAILABLE"
    ):
        fail("change set is not the exact executable UPDATE under review")
    if payload.get("IncludeNestedStacks") not in {None, False}:
        fail("nested-stack activation change sets are forbidden")
    if payload.get("ParentChangeSetId") not in {None, ""}:
        fail("nested parent change sets are forbidden")
    if payload.get("RootChangeSetId") not in {None, "", change_set_id}:
        fail("change set root identity differs from the reviewed change set")
    if sorted(payload.get("Capabilities", [])) != ["CAPABILITY_IAM"]:
        fail("activation change set must use only CAPABILITY_IAM")
    if transition == "roles-anywhere":
        expected_rollback_configuration = {
            "rollbackTriggers": [{
                "Arn": current_identity["rollbackAlarmArn"],
                "Type": "AWS::CloudWatch::Alarm",
            }],
            "monitoringTimeInMinutes": ACTIVATION_MONITORING_MINUTES,
        }
    else:
        expected_rollback_configuration = {
            "rollbackTriggers": [],
            "monitoringTimeInMinutes": 0,
        }
        expected_current_rollback = {
            "rollbackTriggers": [{
                "Arn": current_identity["rollbackAlarmArn"],
                "Type": "AWS::CloudWatch::Alarm",
            }],
            "monitoringTimeInMinutes": ACTIVATION_MONITORING_MINUTES,
        }
        if current_controls["rollbackConfiguration"] != expected_current_rollback:
            fail(
                "lifecycle activation requires the prior activation trigger "
                "and must explicitly clear it",
            )
    desired_controls = validate_change_set_controls(
        payload,
        current_controls=current_controls,
        expected_rollback_configuration=expected_rollback_configuration,
    )
    desired_parameters = normalized_parameters(
        payload.get("Parameters"),
        label="change-set",
    )
    current_map = parameter_map(current_parameters)
    desired_map = parameter_map(desired_parameters)
    if set(desired_map) != set(current_map):
        fail("change set does not explicitly bind the complete parameter set")
    expected_map = dict(current_map)
    if transition == "roles-anywhere":
        expected_map["RolesAnywhereActivation"] = "ENABLED"
        expected_changes = ROLES_ANYWHERE_CHANGES
    else:
        expected_map["LifecycleActivation"] = "ENABLED"
        expected_map["LifecycleBootstrapReceiptSha256"] = (
            bootstrap_receipt_sha256
        )
        expected_changes = LIFECYCLE_CHANGES
    if desired_map != expected_map:
        fail(f"change set parameters exceed the exact {transition} transition")
    changes = payload.get("Changes")
    if not isinstance(changes, list) or len(changes) != len(expected_changes):
        fail("activation change set resource changes exceed the exact allowlist")
    observed: dict[str, str] = {}
    for entry in changes:
        if not isinstance(entry, dict) or not isinstance(
            entry.get("ResourceChange"),
            dict,
        ):
            fail("activation change set contains an invalid resource change")
        change = entry["ResourceChange"]
        logical_id = change.get("LogicalResourceId")
        resource_type = change.get("ResourceType")
        if (
            not isinstance(logical_id, str)
            or logical_id in observed
            or expected_changes.get(logical_id) != resource_type
            or change.get("Action") != "Modify"
            or change.get("Replacement") not in {"False", False}
            or set(change.get("Scope", [])) != {"Properties"}
            or change.get("PolicyAction") not in {None, ""}
        ):
            fail("activation change set exceeds the exact no-replacement allowlist")
        observed[logical_id] = resource_type
    if observed != expected_changes:
        fail("activation change set resource allowlist is incomplete")
    return desired_parameters, desired_controls


def load_reviewed_change_set(
    path: Path,
    expected_sha256: str,
) -> dict[str, Any]:
    try:
        body = path.read_bytes()
    except OSError as error:
        fail(f"reviewed change-set file is unreadable: {error}")
    if len(body) > MAX_JSON_BYTES:
        fail("reviewed change-set file is oversized")
    if sha256_bytes(body) != expected_sha256:
        fail("reviewed change-set file differs from its approved SHA-256")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"reviewed change-set file is invalid JSON: {error}")
    if not isinstance(payload, dict):
        fail("reviewed change-set file must contain one JSON object")
    return payload


def private_file(
    path: Path,
    *,
    label: str,
    owner_uid: int,
    boundary: Path,
) -> None:
    canonical_file(
        path,
        label=label,
        owner_uid=owner_uid,
        boundary=boundary,
    )
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        fail(f"{label} must be owner-private mode 0600")


def load_review_receipt(path: Path, expected_sha256: str) -> dict[str, Any]:
    try:
        body = path.read_bytes()
    except OSError as error:
        fail(f"review receipt is unreadable: {error}")
    if len(body) > MAX_JSON_BYTES:
        fail("review receipt is oversized")
    if sha256_bytes(body) != expected_sha256:
        fail("review receipt differs from the owner-approved SHA-256")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"review receipt is invalid JSON: {error}")
    if not isinstance(payload, dict):
        fail("review receipt must contain one JSON object")
    return payload


def review_binding(
    *,
    transition: str,
    stack_id: str,
    change_set_id: str,
    region: str,
    current: dict[str, Any],
    reviewed_change_set: dict[str, Any],
    reviewed_change_set_sha256: str,
    desired_parameters: list[dict[str, str]],
    desired_controls: dict[str, Any],
    proposed_template_sha256: str,
    aws_config_sha256: str,
    aws_cli_sha256: str,
    bootstrap_receipt_sha256: str | None,
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA,
        "status": "ready-for-owner-approval",
        "transition": transition,
        "stackId": stack_id,
        "changeSetId": change_set_id,
        "region": region,
        "bootstrapReceiptSha256": bootstrap_receipt_sha256,
        "awsConfigSha256": aws_config_sha256,
        "awsCliSha256": aws_cli_sha256,
        "current": {
            "stackStatus": current["stack"]["stackStatus"],
            "templateSha256": current["templateSha256"],
            "parametersSha256": sha256_bytes(
                canonical_json(current["stack"]["parameters"]),
            ),
            "stackControlsSha256": sha256_bytes(
                canonical_json(current["stack"]["controls"]),
            ),
            "resourceIdentitySha256": sha256_bytes(
                canonical_json(current["identity"]),
            ),
            "liveRolesAnywhereStateSha256": sha256_bytes(
                canonical_json(current["liveRolesAnywhereState"]),
            ),
            "liveLifecycleStateSha256": sha256_bytes(
                canonical_json(current["liveLifecycleState"]),
            ),
        },
        "reviewedChangeSet": {
            "reviewedFileSha256": reviewed_change_set_sha256,
            "canonicalContentSha256": sha256_bytes(
                canonical_json(reviewed_change_set),
            ),
            "templateSha256": proposed_template_sha256,
            "desiredParametersSha256": sha256_bytes(
                canonical_json(desired_parameters),
            ),
            "desiredStackControlsSha256": sha256_bytes(
                canonical_json(desired_controls),
            ),
        },
        "credentialsPersisted": False,
        "rawAwsResponsesPersisted": False,
    }


def prepare_review(
    *,
    cli: AwsCli,
    transition: str,
    stack_id: str,
    change_set_id: str,
    template_sha256_value: str,
    current_parameters_sha256: str,
    bootstrap_receipt_sha256: str | None,
    partition: str,
    region: str,
    account: str,
    reviewed_change_set: dict[str, Any],
    reviewed_change_set_sha256: str,
    aws_config_sha256: str,
    aws_cli_sha256: str,
) -> tuple[
    dict[str, Any],
    dict[str, Any],
    list[dict[str, str]],
    dict[str, Any],
]:
    current = observe_phase(
        cli,
        stack_id=stack_id,
        template_digest=template_sha256_value,
        transition=transition,
        final=False,
        bootstrap_receipt_sha256=bootstrap_receipt_sha256,
        partition=partition,
        region=region,
        account=account,
    )
    stack_match = STACK_ARN.fullmatch(stack_id)
    if stack_match is None:
        fail("stack ARN changed during activation review")
    require_idle_activation_alarm(
        cli,
        alarm_arn=current["identity"]["rollbackAlarmArn"],
        stack_name=stack_match.group(4),
    )
    current_parameters = current["stack"]["parameters"]
    if (
        sha256_bytes(canonical_json(current_parameters))
        != current_parameters_sha256
    ):
        fail("current stack parameters differ from their approved SHA-256")
    live_change_set = describe_change_set(
        cli,
        stack_id=stack_id,
        change_set_id=change_set_id,
    )
    if canonical_json(live_change_set) != canonical_json(reviewed_change_set):
        fail("live change set differs from the exact reviewed change-set content")
    desired_parameters, desired_controls = validate_change_set(
        live_change_set,
        stack_id=stack_id,
        change_set_id=change_set_id,
        transition=transition,
        current_parameters=current_parameters,
        current_controls=current["stack"]["controls"],
        current_identity=current["identity"],
        bootstrap_receipt_sha256=bootstrap_receipt_sha256,
    )
    proposed_template_sha256 = template_sha256(
        cli,
        stack_id=stack_id,
        change_set_id=change_set_id,
    )
    if proposed_template_sha256 != template_sha256_value:
        fail("proposed change-set template differs from the reviewed template")

    current_recheck = observe_phase(
        cli,
        stack_id=stack_id,
        template_digest=template_sha256_value,
        transition=transition,
        final=False,
        bootstrap_receipt_sha256=bootstrap_receipt_sha256,
        partition=partition,
        region=region,
        account=account,
    )
    if canonical_json(current_recheck) != canonical_json(current):
        fail("current stack or live control state changed during inspection")
    change_set_recheck = describe_change_set(
        cli,
        stack_id=stack_id,
        change_set_id=change_set_id,
    )
    if canonical_json(change_set_recheck) != canonical_json(reviewed_change_set):
        fail("reviewed change set changed during inspection")
    if (
        template_sha256(
            cli,
            stack_id=stack_id,
            change_set_id=change_set_id,
        )
        != template_sha256_value
    ):
        fail("reviewed change-set template changed during inspection")
    binding = review_binding(
        transition=transition,
        stack_id=stack_id,
        change_set_id=change_set_id,
        region=region,
        current=current,
        reviewed_change_set=reviewed_change_set,
        reviewed_change_set_sha256=reviewed_change_set_sha256,
        desired_parameters=desired_parameters,
        desired_controls=desired_controls,
        proposed_template_sha256=proposed_template_sha256,
        aws_config_sha256=aws_config_sha256,
        aws_cli_sha256=aws_cli_sha256,
        bootstrap_receipt_sha256=bootstrap_receipt_sha256,
    )
    return binding, current, desired_parameters, desired_controls


def stable_resource_identity(identity: dict[str, str]) -> dict[str, str]:
    return dict(identity)


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def update_activation_journal(
    path: Path,
    journal: dict[str, Any],
    *,
    phase: str,
    owner_uid: int,
    boundary: Path,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    updated = {
        **journal,
        "phase": phase,
        "updatedAt": utc_now(),
    }
    if extra:
        updated.update(extra)
    write_journal(
        path,
        updated,
        owner_uid=owner_uid,
        boundary=boundary,
        create=False,
    )
    return updated


def reverify_execution_authorization(
    *,
    cli: AwsCli,
    transition: str,
    stack_id: str,
    change_set_id: str,
    template_digest: str,
    bootstrap_receipt_sha256: str | None,
    partition: str,
    region: str,
    account: str,
    current: dict[str, Any],
    reviewed_change_set: dict[str, Any],
    reviewed_change_set_path: Path,
    reviewed_change_set_sha256: str,
    review_receipt_path: Path,
    review_receipt_sha256: str,
    binding: dict[str, Any],
    aws_config: Path,
    aws_config_sha256: str,
    aws_binary: Path,
    aws_cli_sha256: str,
    lease_stack_name: str | None,
) -> None:
    current_recheck = observe_phase(
        cli,
        stack_id=stack_id,
        template_digest=template_digest,
        transition=transition,
        final=False,
        bootstrap_receipt_sha256=bootstrap_receipt_sha256,
        partition=partition,
        region=region,
        account=account,
    )
    if canonical_json(current_recheck) != canonical_json(current):
        fail("live activation predecessor changed after owner authorization")
    if lease_stack_name is not None:
        publish_activation_metric(cli, stack_name=lease_stack_name)

    live_change_set = describe_change_set(
        cli,
        stack_id=stack_id,
        change_set_id=change_set_id,
    )
    if canonical_json(live_change_set) != canonical_json(reviewed_change_set):
        fail("reviewed change set changed after owner authorization")
    if template_sha256(
        cli,
        stack_id=stack_id,
        change_set_id=change_set_id,
    ) != template_digest:
        fail("reviewed change-set template changed after owner authorization")
    if lease_stack_name is not None:
        publish_activation_metric(cli, stack_name=lease_stack_name)

    receipt = load_review_receipt(
        review_receipt_path,
        review_receipt_sha256,
    )
    if (
        set(receipt) != {*binding, "inspectedAt"}
        or {
            key: value
            for key, value in receipt.items()
            if key != "inspectedAt"
        } != binding
    ):
        fail("owner authorization changed immediately before execution")
    if (
        canonical_json(
            load_reviewed_change_set(
                reviewed_change_set_path,
                reviewed_change_set_sha256,
            ),
        )
        != canonical_json(reviewed_change_set)
        or sha256_file(aws_config) != aws_config_sha256
        or sha256_file(aws_binary) != aws_cli_sha256
    ):
        fail("authorized executable inputs changed immediately before execution")


def activation_result(
    *,
    status: str,
    transition: str,
    stack_id: str,
    change_set_id: str,
    region: str,
    review_receipt_sha256: str,
    binding: dict[str, Any],
    bootstrap_receipt_sha256: str | None,
    observed: dict[str, Any],
    crl_sha256: str | None,
    probe_sha256: str | None,
    alarm: dict[str, str] | None,
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA,
        "status": status,
        "transition": transition,
        "observedAt": utc_now(),
        "stackId": stack_id,
        "changeSetId": change_set_id,
        "region": region,
        "reviewReceiptSha256": review_receipt_sha256,
        "reviewBindingSha256": sha256_bytes(canonical_json(binding)),
        "bootstrapReceiptSha256": bootstrap_receipt_sha256,
        "postEnableCrlEvidenceSha256": crl_sha256,
        "postEnableProbeEvidenceSha256": probe_sha256,
        "rollbackAlarm": alarm,
        "finalState": {
            "stackStatus": observed["stack"]["stackStatus"],
            "templateSha256": observed["templateSha256"],
            "parametersSha256": sha256_bytes(
                canonical_json(observed["stack"]["parameters"]),
            ),
            "stackControlsSha256": sha256_bytes(
                canonical_json(observed["stack"]["controls"]),
            ),
            "resourceIdentitySha256": sha256_bytes(
                canonical_json(observed["identity"]),
            ),
            "liveStateSha256": sha256_bytes(
                canonical_json(
                    {
                        "rolesAnywhere": observed["liveRolesAnywhereState"],
                        "lifecycle": observed["liveLifecycleState"],
                    },
                ),
            ),
        },
        "credentialsPersisted": False,
        "rawAwsResponsesPersisted": False,
    }


def drive_roles_anywhere_activation(
    *,
    cli: AwsCli,
    stack_id: str,
    stack_name: str,
    change_set_id: str,
    template_digest: str,
    current: dict[str, Any],
    desired_parameters: list[dict[str, str]],
    desired_controls: dict[str, Any],
    partition: str,
    region: str,
    account: str,
    binding: dict[str, Any],
    review_receipt_sha256: str,
    journal_path: Path,
    journal: dict[str, Any],
    evidence_path: Path,
    crl_verifier_executable: Path,
    crl_verifier_arguments: list[str],
    crl_evidence_path: Path,
    probe_executable: Path,
    probe_arguments: list[str],
    probe_evidence_path: Path,
    owner_uid: int,
    trust_boundary: Path,
    wait_timeout_seconds: int,
    poll_seconds: int,
) -> tuple[bool, dict[str, Any]]:
    alarm_arn = current["identity"]["rollbackAlarmArn"]
    deadline = time.monotonic() + wait_timeout_seconds
    crl_result: dict[str, Any] | None = None
    probe_result: dict[str, Any] | None = None

    while time.monotonic() < deadline:
        stack = describe_stack(cli, stack_id)
        status = stack["stackStatus"]
        if status in ROLLBACK_ACTIVE_STATUSES:
            journal = update_activation_journal(
                journal_path,
                journal,
                phase="cloudformation-rollback-in-progress",
                owner_uid=owner_uid,
                boundary=trust_boundary,
            )
            time.sleep(poll_seconds)
            continue
        if status in ROLLBACK_TERMINAL_STATUSES:
            rolled_back = observe_phase(
                cli,
                stack_id=stack_id,
                template_digest=template_digest,
                transition="roles-anywhere",
                final=False,
                bootstrap_receipt_sha256=None,
                partition=partition,
                region=region,
                account=account,
                expected_parameters=current["stack"]["parameters"],
                expected_controls=current["stack"]["controls"],
                allowed_statuses=ROLLBACK_TERMINAL_STATUSES,
            )
            if (
                stable_resource_identity(rolled_back["identity"])
                != stable_resource_identity(current["identity"])
            ):
                fail("rolled-back resource identity differs from the reviewed state")
            result = activation_result(
                status="rolled-back",
                transition="roles-anywhere",
                stack_id=stack_id,
                change_set_id=change_set_id,
                region=region,
                review_receipt_sha256=review_receipt_sha256,
                binding=binding,
                bootstrap_receipt_sha256=None,
                observed=rolled_back,
                crl_sha256=None,
                probe_sha256=None,
                alarm=None,
            )
            if not evidence_path.exists():
                write_evidence(evidence_path, result)
            journal = update_activation_journal(
                journal_path,
                journal,
                phase="rolled-back",
                owner_uid=owner_uid,
                boundary=trust_boundary,
                extra={"resultSha256": sha256_file(evidence_path)},
            )
            return False, result
        if status not in {*UPDATE_ACTIVE_STATUSES, "UPDATE_COMPLETE"}:
            fail(f"activation entered unsupported CloudFormation status {status}")

        alarm = describe_activation_alarm(
            cli,
            alarm_arn=alarm_arn,
            stack_name=stack_name,
        )
        if alarm["state"] == "ALARM":
            journal = update_activation_journal(
                journal_path,
                journal,
                phase="alarm-triggered-waiting-for-rollback",
                owner_uid=owner_uid,
                boundary=trust_boundary,
            )
            time.sleep(poll_seconds)
            continue
        if (
            status == "UPDATE_COMPLETE"
            and stack["parameters"] == current["stack"]["parameters"]
            and stack["controls"] == current["stack"]["controls"]
        ):
            # execute-change-set may be accepted before describe-stacks exposes
            # UPDATE_IN_PROGRESS. Keep the exact reviewed predecessor leased
            # during that bounded consistency window.
            publish_activation_metric(
                cli,
                stack_name=stack_name,
            )
            journal = update_activation_journal(
                journal_path,
                journal,
                phase="waiting-for-cloudformation-update",
                owner_uid=owner_uid,
                boundary=trust_boundary,
            )
            time.sleep(poll_seconds)
            continue

        transition_state = roles_anywhere_state(
            cli,
            identity=current["identity"],
            enabled=None,
        )
        lifecycle_state(
            cli,
            bucket=current["identity"]["bucket"],
            prefix=current["identity"]["prefix"],
            enabled=False,
        )
        if not transition_state["allEnabled"]:
            if status == "UPDATE_COMPLETE":
                fail("CloudFormation completed without the exact enabled identity plane")
            publish_activation_metric(
                cli,
                stack_name=stack_name,
            )
            journal = update_activation_journal(
                journal_path,
                journal,
                phase="resources-enabling",
                owner_uid=owner_uid,
                boundary=trust_boundary,
            )
            time.sleep(poll_seconds)
            continue

        # The stack, alarm, four Roles Anywhere resources, and lifecycle state
        # form one bounded seven-call chunk. Renew only after all returned
        # state is structurally valid and the identity plane is fully enabled.
        publish_activation_metric(
            cli,
            stack_name=stack_name,
        )
        allowed_statuses = {*UPDATE_ACTIVE_STATUSES, "UPDATE_COMPLETE"}
        verified = observe_phase(
            cli,
            stack_id=stack_id,
            template_digest=template_digest,
            transition="roles-anywhere",
            final=True,
            bootstrap_receipt_sha256=None,
            partition=partition,
            region=region,
            account=account,
            expected_parameters=desired_parameters,
            expected_controls=desired_controls,
            allowed_statuses=allowed_statuses,
        )
        if (
            stable_resource_identity(verified["identity"])
            != stable_resource_identity(current["identity"])
        ):
            fail("Roles Anywhere resource identity changed during activation")
        # observe_phase is another bounded seven-call validation chunk. This
        # renewal leaves the full alarm window for the sequential CRL verifier.
        publish_activation_metric(
            cli,
            stack_name=stack_name,
        )
        if crl_result is None:
            crl_result = run_post_enable_crl_verifier(
                executable=crl_verifier_executable,
                arguments=crl_verifier_arguments,
                evidence_path=crl_evidence_path,
                identity=verified["identity"],
                region=region,
                owner_uid=owner_uid,
                boundary=trust_boundary,
                environment=cli.environment,
            )
        else:
            crl_result = validate_crl_live_evidence(
                crl_evidence_path,
                expected_sha256=crl_result["sha256"],
                identity=verified["identity"],
                region=region,
                owner_uid=owner_uid,
                boundary=trust_boundary,
            )
        publish_activation_metric(
            cli,
            stack_name=stack_name,
        )
        if probe_result is None:
            probe_result = run_post_enable_probe(
                executable=probe_executable,
                arguments=probe_arguments,
                evidence_path=probe_evidence_path,
                identity=verified["identity"],
                region=region,
                owner_uid=owner_uid,
                boundary=trust_boundary,
            )
        else:
            probe_result = validate_probe_evidence(
                probe_evidence_path,
                expected_sha256=probe_result["sha256"],
                identity=verified["identity"],
                region=region,
                owner_uid=owner_uid,
                boundary=trust_boundary,
            )
        publish_activation_metric(
            cli,
            stack_name=stack_name,
        )
        alarm = describe_activation_alarm(
            cli,
            alarm_arn=alarm_arn,
            stack_name=stack_name,
        )
        if alarm["state"] != "OK":
            fail("post-probe activation rollback alarm is not OK")
        journal = update_activation_journal(
            journal_path,
            journal,
            phase="post-enable-probes-passed",
            owner_uid=owner_uid,
            boundary=trust_boundary,
            extra={
                "postEnableCrlEvidenceSha256": crl_result["sha256"],
                "postEnableProbeEvidenceSha256": probe_result["sha256"],
            },
        )
        if status != "UPDATE_COMPLETE":
            time.sleep(poll_seconds)
            continue

        final = observe_phase(
            cli,
            stack_id=stack_id,
            template_digest=template_digest,
            transition="roles-anywhere",
            final=True,
            bootstrap_receipt_sha256=None,
            partition=partition,
            region=region,
            account=account,
            expected_parameters=desired_parameters,
            expected_controls=desired_controls,
        )
        if (
            stable_resource_identity(final["identity"])
            != stable_resource_identity(current["identity"])
        ):
            fail("Roles Anywhere resource identity changed during activation")
        validate_probe_evidence(
            probe_evidence_path,
            expected_sha256=probe_result["sha256"],
            identity=final["identity"],
            region=region,
            owner_uid=owner_uid,
            boundary=trust_boundary,
        )
        validate_crl_live_evidence(
            crl_evidence_path,
            expected_sha256=crl_result["sha256"],
            identity=final["identity"],
            region=region,
            owner_uid=owner_uid,
            boundary=trust_boundary,
        )
        publish_activation_metric(
            cli,
            stack_name=stack_name,
        )
        final_alarm = describe_activation_alarm(
            cli,
            alarm_arn=alarm_arn,
            stack_name=stack_name,
        )
        if final_alarm["state"] != "OK":
            fail("final activation rollback alarm is not OK")
        result = activation_result(
            status="passed",
            transition="roles-anywhere",
            stack_id=stack_id,
            change_set_id=change_set_id,
            region=region,
            review_receipt_sha256=review_receipt_sha256,
            binding=binding,
            bootstrap_receipt_sha256=None,
            observed=final,
            crl_sha256=crl_result["sha256"],
            probe_sha256=probe_result["sha256"],
            alarm=final_alarm,
        )
        if not evidence_path.exists():
            write_evidence(evidence_path, result)
        journal = update_activation_journal(
            journal_path,
            journal,
            phase="passed",
            owner_uid=owner_uid,
            boundary=trust_boundary,
            extra={"resultSha256": sha256_file(evidence_path)},
        )
        return True, result
    fail("activation monitoring exceeded its bounded wait deadline")


def drive_lifecycle_activation(
    *,
    cli: AwsCli,
    stack_id: str,
    change_set_id: str,
    template_digest: str,
    current: dict[str, Any],
    desired_parameters: list[dict[str, str]],
    desired_controls: dict[str, Any],
    partition: str,
    region: str,
    account: str,
    binding: dict[str, Any],
    review_receipt_sha256: str,
    bootstrap_receipt_sha256: str,
    journal_path: Path,
    journal: dict[str, Any],
    evidence_path: Path,
    owner_uid: int,
    trust_boundary: Path,
    wait_timeout_seconds: int,
    poll_seconds: int,
) -> tuple[bool, dict[str, Any]]:
    deadline = time.monotonic() + wait_timeout_seconds
    while time.monotonic() < deadline:
        stack = describe_stack(cli, stack_id)
        status = stack["stackStatus"]
        if status in ROLLBACK_ACTIVE_STATUSES:
            journal = update_activation_journal(
                journal_path,
                journal,
                phase="cloudformation-rollback-in-progress",
                owner_uid=owner_uid,
                boundary=trust_boundary,
            )
            time.sleep(poll_seconds)
            continue
        if status in ROLLBACK_TERMINAL_STATUSES:
            rolled_back = observe_phase(
                cli,
                stack_id=stack_id,
                template_digest=template_digest,
                transition="lifecycle",
                final=False,
                bootstrap_receipt_sha256=bootstrap_receipt_sha256,
                partition=partition,
                region=region,
                account=account,
                expected_parameters=current["stack"]["parameters"],
                expected_controls=current["stack"]["controls"],
                allowed_statuses=ROLLBACK_TERMINAL_STATUSES,
            )
            if (
                stable_resource_identity(rolled_back["identity"])
                != stable_resource_identity(current["identity"])
            ):
                fail("rolled-back lifecycle resource identity differs")
            result = activation_result(
                status="rolled-back",
                transition="lifecycle",
                stack_id=stack_id,
                change_set_id=change_set_id,
                region=region,
                review_receipt_sha256=review_receipt_sha256,
                binding=binding,
                bootstrap_receipt_sha256=bootstrap_receipt_sha256,
                observed=rolled_back,
                crl_sha256=None,
                probe_sha256=None,
                alarm=None,
            )
            if not evidence_path.exists():
                write_evidence(evidence_path, result)
            journal = update_activation_journal(
                journal_path,
                journal,
                phase="rolled-back",
                owner_uid=owner_uid,
                boundary=trust_boundary,
                extra={"resultSha256": sha256_file(evidence_path)},
            )
            return False, result
        if status in UPDATE_ACTIVE_STATUSES:
            journal = update_activation_journal(
                journal_path,
                journal,
                phase="lifecycle-update-in-progress",
                owner_uid=owner_uid,
                boundary=trust_boundary,
            )
            time.sleep(poll_seconds)
            continue
        if status != "UPDATE_COMPLETE":
            fail(f"lifecycle activation entered unsupported status {status}")
        if stack["parameters"] == current["stack"]["parameters"]:
            # An accepted request may be briefly visible before the stack
            # enters UPDATE_IN_PROGRESS. Never infer completion from status
            # alone because predecessor and desired can both be UPDATE_COMPLETE.
            time.sleep(poll_seconds)
            continue
        if stack["parameters"] != desired_parameters:
            fail("lifecycle activation parameters are neither predecessor nor desired")
        final = observe_phase(
            cli,
            stack_id=stack_id,
            template_digest=template_digest,
            transition="lifecycle",
            final=True,
            bootstrap_receipt_sha256=bootstrap_receipt_sha256,
            partition=partition,
            region=region,
            account=account,
            expected_parameters=desired_parameters,
            expected_controls=desired_controls,
        )
        if (
            stable_resource_identity(final["identity"])
            != stable_resource_identity(current["identity"])
        ):
            fail("lifecycle resource identity changed during activation")
        result = activation_result(
            status="passed",
            transition="lifecycle",
            stack_id=stack_id,
            change_set_id=change_set_id,
            region=region,
            review_receipt_sha256=review_receipt_sha256,
            binding=binding,
            bootstrap_receipt_sha256=bootstrap_receipt_sha256,
            observed=final,
            crl_sha256=None,
            probe_sha256=None,
            alarm=None,
        )
        if not evidence_path.exists():
            write_evidence(evidence_path, result)
        journal = update_activation_journal(
            journal_path,
            journal,
            phase="passed",
            owner_uid=owner_uid,
            boundary=trust_boundary,
            extra={"resultSha256": sha256_file(evidence_path)},
        )
        return True, result
    fail("lifecycle activation exceeded its bounded wait deadline")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--operation",
        choices=("inspect", "execute", "recover-or-finalize"),
        required=True,
    )
    parser.add_argument(
        "--transition",
        choices=("roles-anywhere", "lifecycle"),
        required=True,
    )
    parser.add_argument("--stack-id", required=True)
    parser.add_argument("--change-set-id", required=True)
    parser.add_argument("--reviewed-change-set", required=True, type=Path)
    parser.add_argument("--reviewed-change-set-sha256", required=True)
    parser.add_argument("--expected-template-sha256", required=True)
    parser.add_argument("--expected-current-parameters-sha256", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--aws-bin", required=True, type=Path)
    parser.add_argument("--aws-config", required=True, type=Path)
    parser.add_argument("--aws-profile", required=True)
    parser.add_argument("--review-receipt", required=True, type=Path)
    parser.add_argument("--review-receipt-sha256", default="")
    parser.add_argument("--evidence-out", type=Path)
    parser.add_argument("--journal", type=Path)
    parser.add_argument("--post-enable-crl-verifier-bin", type=Path)
    parser.add_argument("--post-enable-crl-verifier-bin-sha256", default="")
    parser.add_argument("--post-enable-crl-verifier-arguments", type=Path)
    parser.add_argument(
        "--post-enable-crl-verifier-arguments-sha256",
        default="",
    )
    parser.add_argument("--post-enable-crl-evidence", type=Path)
    parser.add_argument("--post-enable-probe-bin", type=Path)
    parser.add_argument("--post-enable-probe-bin-sha256", default="")
    parser.add_argument("--post-enable-probe-arguments", type=Path)
    parser.add_argument("--post-enable-probe-arguments-sha256", default="")
    parser.add_argument("--post-enable-probe-evidence", type=Path)
    parser.add_argument("--bootstrap-receipt", type=Path)
    parser.add_argument("--bootstrap-receipt-sha256", default="")
    parser.add_argument("--expected-owner-uid", type=int, default=0)
    parser.add_argument("--trust-boundary", type=Path, default=Path("/"))
    parser.add_argument("--command-timeout-seconds", type=int, default=30)
    parser.add_argument("--wait-timeout-seconds", type=int, default=3600)
    parser.add_argument("--alarm-prime-timeout-seconds", type=int, default=300)
    parser.add_argument("--poll-interval-seconds", type=int, default=15)
    parser.add_argument("--execute-reviewed-change-set", action="store_true")
    args = parser.parse_args()

    stack_match = STACK_ARN.fullmatch(args.stack_id)
    change_set_match = CHANGE_SET_ARN.fullmatch(args.change_set_id)
    if stack_match is None or change_set_match is None:
        fail("stack and change-set IDs must be exact full CloudFormation ARNs")
    partition, stack_region, account = stack_match.group(1, 2, 3)
    if (
        change_set_match.group(1) != partition
        or change_set_match.group(2) != stack_region
        or change_set_match.group(3) != account
        or args.region != stack_region
        or not REGION.fullmatch(args.region)
    ):
        fail("stack, change set, account, partition, and region do not match")
    if not PROFILE.fullmatch(args.aws_profile):
        fail("AWS profile name is invalid")
    for value, label in (
        (args.reviewed_change_set_sha256, "reviewed change-set SHA-256"),
        (args.expected_template_sha256, "expected template SHA-256"),
        (
            args.expected_current_parameters_sha256,
            "expected current-parameters SHA-256",
        ),
    ):
        if not SHA256.fullmatch(value):
            fail(f"{label} is invalid")
    if args.expected_owner_uid < 0:
        fail("expected owner UID is invalid")
    if not 1 <= args.command_timeout_seconds <= 30:
        fail("command timeout must be between 1 and 30 seconds")
    if not 60 <= args.wait_timeout_seconds <= 7200:
        fail("wait timeout must be between 60 and 7200 seconds")
    if not 60 <= args.alarm_prime_timeout_seconds <= 900:
        fail("alarm prime timeout must be between 60 and 900 seconds")
    if not 1 <= args.poll_interval_seconds <= 60:
        fail("poll interval must be between 1 and 60 seconds")

    if args.operation == "recover-or-finalize":
        if args.execute_reviewed_change_set:
            fail("recovery cannot execute a reviewed change set")
        if (
            not SHA256.fullmatch(args.review_receipt_sha256)
            or args.evidence_out is None
        ):
            fail(
                "recovery requires the exact review receipt/digest "
                "and evidence path",
            )
    elif args.operation == "inspect":
        if args.execute_reviewed_change_set:
            fail("inspect operation cannot execute a change set")
        if args.review_receipt_sha256 or args.evidence_out is not None:
            fail("inspect accepts only a new review-receipt output")
        private_output_parent(
            args.review_receipt,
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
    else:
        if (
            not args.execute_reviewed_change_set
            or not SHA256.fullmatch(args.review_receipt_sha256)
            or args.evidence_out is None
        ):
            fail(
                "execute requires the exact review receipt/digest, "
                "an evidence output, and --execute-reviewed-change-set",
            )
        if args.evidence_out == args.review_receipt:
            fail("execution evidence must not overwrite the review receipt")
        private_output_parent(
            args.evidence_out,
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
    for path, label in (
        (args.aws_config, "AWS config"),
        (args.reviewed_change_set, "reviewed change-set file"),
    ):
        if not path.is_absolute():
            fail(f"{label} path must be absolute")
        private_file(
            path,
            label=label,
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
    aws_binary = trusted_executable(
        args.aws_bin,
        label="AWS CLI",
        owner_uid=args.expected_owner_uid,
        boundary=args.trust_boundary,
    )

    probe_executable: Path | None = None
    probe_arguments: list[str] | None = None
    crl_verifier_executable: Path | None = None
    crl_verifier_arguments: list[str] | None = None
    crl_control: dict[str, Any] | None = None
    probe_control: dict[str, Any] | None = None
    if args.transition == "roles-anywhere":
        if (
            args.journal is None
            or args.post_enable_crl_verifier_bin is None
            or not SHA256.fullmatch(
                args.post_enable_crl_verifier_bin_sha256,
            )
            or args.post_enable_crl_verifier_arguments is None
            or not SHA256.fullmatch(
                args.post_enable_crl_verifier_arguments_sha256,
            )
            or args.post_enable_crl_evidence is None
            or args.post_enable_probe_bin is None
            or not SHA256.fullmatch(args.post_enable_probe_bin_sha256)
            or args.post_enable_probe_arguments is None
            or not SHA256.fullmatch(args.post_enable_probe_arguments_sha256)
            or args.post_enable_probe_evidence is None
        ):
            fail(
                "Roles Anywhere activation requires the exact journal and "
                "post-enable CRL/probe executables, arguments, digests, and evidence",
            )
        if len({
            args.review_receipt,
            args.journal,
            args.post_enable_crl_evidence,
            args.post_enable_probe_evidence,
            *(()
              if args.evidence_out is None
              else (args.evidence_out,)),
        }) != (
            4 if args.evidence_out is None else 5
        ):
            fail(
                "activation review, journal, CRL, probe, and result paths must differ",
            )
        crl_verifier_executable = trusted_executable(
            args.post_enable_crl_verifier_bin,
            label="post-enable CRL verifier",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        if (
            sha256_file(crl_verifier_executable)
            != args.post_enable_crl_verifier_bin_sha256
        ):
            fail("post-enable CRL verifier differs from its approved SHA-256")
        if not args.post_enable_crl_verifier_arguments.is_absolute():
            fail("post-enable CRL verifier argument path must be absolute")
        private_file(
            args.post_enable_crl_verifier_arguments,
            label="post-enable CRL verifier arguments",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        crl_verifier_arguments = load_probe_arguments(
            args.post_enable_crl_verifier_arguments,
            args.post_enable_crl_verifier_arguments_sha256,
        )
        probe_executable = trusted_executable(
            args.post_enable_probe_bin,
            label="post-enable probe",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        if sha256_file(probe_executable) != args.post_enable_probe_bin_sha256:
            fail("post-enable probe differs from its approved SHA-256")
        if not args.post_enable_probe_arguments.is_absolute():
            fail("post-enable probe argument path must be absolute")
        private_file(
            args.post_enable_probe_arguments,
            label="post-enable probe arguments",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        probe_arguments = load_probe_arguments(
            args.post_enable_probe_arguments,
            args.post_enable_probe_arguments_sha256,
        )
        if args.operation == "inspect":
            private_output_parent(
                args.journal,
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )
            private_output_parent(
                args.post_enable_crl_evidence,
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )
            private_output_parent(
                args.post_enable_probe_evidence,
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )
        elif args.operation == "execute":
            private_output_parent(
                args.journal,
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )
            private_output_parent(
                args.post_enable_crl_evidence,
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )
            private_output_parent(
                args.post_enable_probe_evidence,
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )
        crl_control = {
            "executableSha256": args.post_enable_crl_verifier_bin_sha256,
            "argumentsFileSha256": (
                args.post_enable_crl_verifier_arguments_sha256
            ),
            "argumentsCanonicalSha256": sha256_bytes(
                canonical_json(crl_verifier_arguments),
            ),
            "evidencePathSha256": sha256_bytes(
                str(args.post_enable_crl_evidence).encode(),
            ),
            "maxSeconds": MAX_CRL_VERIFY_SECONDS,
        }
        probe_control = {
            "executableSha256": args.post_enable_probe_bin_sha256,
            "argumentsFileSha256": args.post_enable_probe_arguments_sha256,
            "argumentsCanonicalSha256": sha256_bytes(
                canonical_json(probe_arguments),
            ),
            "evidencePathSha256": sha256_bytes(
                str(args.post_enable_probe_evidence).encode(),
            ),
            "journalPathSha256": sha256_bytes(str(args.journal).encode()),
            "maxSeconds": MAX_PROBE_SECONDS,
        }
    elif (
        args.journal is None
        or any(
            value is not None and value != ""
            for value in (
            args.post_enable_crl_verifier_bin,
            args.post_enable_crl_verifier_bin_sha256,
            args.post_enable_crl_verifier_arguments,
            args.post_enable_crl_verifier_arguments_sha256,
            args.post_enable_crl_evidence,
            args.post_enable_probe_bin,
            args.post_enable_probe_bin_sha256,
            args.post_enable_probe_arguments,
            args.post_enable_probe_arguments_sha256,
            args.post_enable_probe_evidence,
            )
        )
    ):
        fail(
            "lifecycle activation requires an exact journal and must not "
            "accept Roles Anywhere probe controls",
        )
    else:
        if (
            args.journal == args.review_receipt
            or (
                args.evidence_out is not None
                and args.journal == args.evidence_out
            )
        ):
            fail("lifecycle review, journal, and result paths must differ")
        if args.operation in {"inspect", "execute"}:
            private_output_parent(
                args.journal,
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )

    if args.transition == "lifecycle":
        if (
            args.bootstrap_receipt is None
            or not args.bootstrap_receipt.is_absolute()
            or not SHA256.fullmatch(args.bootstrap_receipt_sha256)
        ):
            fail("lifecycle transition requires an exact bootstrap receipt/digest")
        private_file(
            args.bootstrap_receipt,
            label="bootstrap receipt",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        if sha256_file(args.bootstrap_receipt) != args.bootstrap_receipt_sha256:
            fail("bootstrap receipt differs from its approved SHA-256")
        bootstrap_receipt_sha256: str | None = args.bootstrap_receipt_sha256
    else:
        if args.bootstrap_receipt is not None or args.bootstrap_receipt_sha256:
            fail("Roles Anywhere transition must not accept a bootstrap receipt")
        bootstrap_receipt_sha256 = None
    if args.operation in {"execute", "recover-or-finalize"}:
        if not args.review_receipt.is_absolute():
            fail("review receipt path must be absolute")
        private_file(
            args.review_receipt,
            label="review receipt",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )

    reviewed_change_set = load_reviewed_change_set(
        args.reviewed_change_set,
        args.reviewed_change_set_sha256,
    )
    cli = AwsCli(
        binary=aws_binary,
        config=args.aws_config,
        profile=args.aws_profile,
        region=args.region,
        command_timeout=args.command_timeout_seconds,
        wait_timeout=args.wait_timeout_seconds,
    )

    aws_config_sha256 = sha256_file(args.aws_config)
    aws_cli_sha256 = sha256_file(aws_binary)

    if args.operation == "recover-or-finalize":
        if args.journal is None:
            fail("recover-or-finalize requires the exact activation journal")
        review_receipt = load_review_receipt(
            args.review_receipt,
            args.review_receipt_sha256,
        )
        journal = load_journal(
            args.journal,
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        binding = {
            key: value
            for key, value in review_receipt.items()
            if key != "inspectedAt"
        }
        required_journal = {
            "schemaVersion": JOURNAL_SCHEMA,
            "stackId": args.stack_id,
            "changeSetId": args.change_set_id,
            "region": args.region,
            "transition": args.transition,
            "reviewReceiptSha256": args.review_receipt_sha256,
            "expectedTemplateSha256": args.expected_template_sha256,
            "reviewedChangeSetSha256": args.reviewed_change_set_sha256,
            "awsConfigSha256": aws_config_sha256,
            "awsCliSha256": aws_cli_sha256,
            "bootstrapReceiptSha256": bootstrap_receipt_sha256,
            "binding": binding,
        }
        for key, value in required_journal.items():
            if journal.get(key) != value:
                fail(f"activation journal differs from exact {key}")
        current = journal.get("current")
        desired_parameters = journal.get("desiredParameters")
        desired_controls = journal.get("desiredControls")
        if (
            not isinstance(current, dict)
            or not isinstance(desired_parameters, list)
            or not isinstance(desired_controls, dict)
            or args.evidence_out is None
        ):
            fail("activation journal state is incomplete")
        current_binding = binding.get("current")
        desired_binding = binding.get("reviewedChangeSet")
        current_stack = current.get("stack")
        if (
            not isinstance(current_binding, dict)
            or not isinstance(desired_binding, dict)
            or not isinstance(current_stack, dict)
            or current.get("templateSha256")
            != current_binding.get("templateSha256")
            or current_stack.get("stackStatus")
            != current_binding.get("stackStatus")
            or sha256_bytes(canonical_json(
                current_stack.get("parameters"),
            ))
            != current_binding.get("parametersSha256")
            or sha256_bytes(canonical_json(
                current_stack.get("controls"),
            ))
            != current_binding.get("stackControlsSha256")
            or sha256_bytes(canonical_json(current.get("identity")))
            != current_binding.get("resourceIdentitySha256")
            or sha256_bytes(canonical_json(
                current.get("liveRolesAnywhereState"),
            ))
            != current_binding.get("liveRolesAnywhereStateSha256")
            or sha256_bytes(canonical_json(
                current.get("liveLifecycleState"),
            ))
            != current_binding.get("liveLifecycleStateSha256")
            or sha256_bytes(canonical_json(desired_parameters))
            != desired_binding.get("desiredParametersSha256")
            or sha256_bytes(canonical_json(desired_controls))
            != desired_binding.get("desiredStackControlsSha256")
        ):
            fail("activation journal state differs from the owner-reviewed binding")
        if args.transition == "roles-anywhere":
            if (
                crl_verifier_executable is None
                or crl_verifier_arguments is None
                or args.post_enable_crl_evidence is None
                or probe_executable is None
                or probe_arguments is None
                or args.post_enable_probe_evidence is None
            ):
                fail("Roles Anywhere recovery journal state is incomplete")
            validate_crl_verifier_arguments(
                crl_verifier_arguments,
                identity=current["identity"],
                stack_name=stack_match.group(4),
                region=args.region,
                aws_profile=args.aws_profile,
                evidence_path=args.post_enable_crl_evidence,
            )
            validate_probe_arguments(
                probe_arguments,
                identity=current["identity"],
                region=args.region,
                aws_binary=aws_binary,
                evidence_path=args.post_enable_probe_evidence,
                live_crl_evidence_path=args.post_enable_crl_evidence,
                owner_uid=args.expected_owner_uid,
                trust_boundary=args.trust_boundary,
            )
        phase = journal.get("phase")
        if phase in {"passed", "rolled-back"}:
            result_sha = journal.get("resultSha256")
            if (
                not isinstance(result_sha, str)
                or not SHA256.fullmatch(result_sha)
                or not args.evidence_out.exists()
                or sha256_file(args.evidence_out) != result_sha
            ):
                fail("terminal activation journal result is missing or changed")
            print(json.dumps({
                "ok": phase == "passed",
                "operation": "recover-or-finalize",
                "schemaVersion": SCHEMA,
                "status": phase,
                "evidenceSha256": result_sha,
            }, separators=(",", ":"), sort_keys=True))
            if phase != "passed":
                fail("reviewed activation rolled back")
            return
        live_stack = describe_stack(cli, args.stack_id)
        live_change_set = describe_change_set(
            cli,
            stack_id=args.stack_id,
            change_set_id=args.change_set_id,
        )
        execution_status = recovery_change_set_status(
            live_change_set,
            reviewed_change_set,
        )
        live_parameters = live_stack["parameters"]
        pre_execution_phases = {
            "prepared",
            "priming-alarm",
            "alarm-ok",
            "authorization-reverified",
        }
        if (
            phase in pre_execution_phases
            and live_stack["stackStatus"] in COMPLETED_STACK_STATUSES
            and live_parameters == current["stack"]["parameters"]
        ):
            if execution_status != "AVAILABLE":
                fail("pre-execution journal conflicts with accepted change set")
            update_activation_journal(
                args.journal,
                journal,
                phase="aborted-before-execution",
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )
            fail("activation stopped safely before change-set execution")
        if (
            phase == "execution-attempted"
            and live_stack["stackStatus"] in COMPLETED_STACK_STATUSES
            and live_parameters == current["stack"]["parameters"]
            and execution_status == "AVAILABLE"
        ):
            fail(
                "change-set acceptance remains ambiguous after the durable "
                "execution attempt; retry recovery without executing",
            )
        if (
            phase == "execution-attempted"
            and execution_status == "AVAILABLE"
        ):
            fail("execution-attempted journal conflicts with live stack state")
        if live_stack["stackStatus"] not in {
            *UPDATE_ACTIVE_STATUSES,
            *ROLLBACK_ACTIVE_STATUSES,
            *ROLLBACK_TERMINAL_STATUSES,
            "UPDATE_COMPLETE",
        }:
            fail("activation journal and live CloudFormation state are ambiguous")
        if args.transition == "roles-anywhere":
            recovery_alarm = describe_activation_alarm(
                cli,
                alarm_arn=current["identity"]["rollbackAlarmArn"],
                stack_name=stack_match.group(4),
            )
            if recovery_alarm["state"] == "OK":
                # Recovery first validates one bounded stack/change-set/alarm
                # chunk. Only then may it renew before the next sequential
                # observation chunk.
                publish_activation_metric(
                    cli,
                    stack_name=stack_match.group(4),
                )
        if args.transition == "roles-anywhere":
            assert crl_verifier_executable is not None
            assert crl_verifier_arguments is not None
            assert args.post_enable_crl_evidence is not None
            assert probe_executable is not None
            assert probe_arguments is not None
            assert args.post_enable_probe_evidence is not None
            passed, _result = drive_roles_anywhere_activation(
                cli=cli,
                stack_id=args.stack_id,
                stack_name=stack_match.group(4),
                change_set_id=args.change_set_id,
                template_digest=args.expected_template_sha256,
                current=current,
                desired_parameters=desired_parameters,
                desired_controls=desired_controls,
                partition=partition,
                region=args.region,
                account=account,
                binding=binding,
                review_receipt_sha256=args.review_receipt_sha256,
                journal_path=args.journal,
                journal=journal,
                evidence_path=args.evidence_out,
                crl_verifier_executable=crl_verifier_executable,
                crl_verifier_arguments=crl_verifier_arguments,
                crl_evidence_path=args.post_enable_crl_evidence,
                probe_executable=probe_executable,
                probe_arguments=probe_arguments,
                probe_evidence_path=args.post_enable_probe_evidence,
                owner_uid=args.expected_owner_uid,
                trust_boundary=args.trust_boundary,
                wait_timeout_seconds=args.wait_timeout_seconds,
                poll_seconds=args.poll_interval_seconds,
            )
        else:
            assert bootstrap_receipt_sha256 is not None
            passed, _result = drive_lifecycle_activation(
                cli=cli,
                stack_id=args.stack_id,
                change_set_id=args.change_set_id,
                template_digest=args.expected_template_sha256,
                current=current,
                desired_parameters=desired_parameters,
                desired_controls=desired_controls,
                partition=partition,
                region=args.region,
                account=account,
                binding=binding,
                review_receipt_sha256=args.review_receipt_sha256,
                bootstrap_receipt_sha256=bootstrap_receipt_sha256,
                journal_path=args.journal,
                journal=journal,
                evidence_path=args.evidence_out,
                owner_uid=args.expected_owner_uid,
                trust_boundary=args.trust_boundary,
                wait_timeout_seconds=args.wait_timeout_seconds,
                poll_seconds=args.poll_interval_seconds,
            )
        print(json.dumps({
            "ok": passed,
            "operation": "recover-or-finalize",
            "schemaVersion": SCHEMA,
            "status": "passed" if passed else "rolled-back",
            "evidenceSha256": sha256_file(args.evidence_out),
        }, separators=(",", ":"), sort_keys=True))
        if not passed:
            fail("reviewed activation rolled back")
        return

    binding, current, desired_parameters, desired_controls = prepare_review(
        cli=cli,
        transition=args.transition,
        stack_id=args.stack_id,
        change_set_id=args.change_set_id,
        template_sha256_value=args.expected_template_sha256,
        current_parameters_sha256=args.expected_current_parameters_sha256,
        bootstrap_receipt_sha256=bootstrap_receipt_sha256,
        partition=partition,
        region=args.region,
        account=account,
        reviewed_change_set=reviewed_change_set,
        reviewed_change_set_sha256=args.reviewed_change_set_sha256,
        aws_config_sha256=aws_config_sha256,
        aws_cli_sha256=aws_cli_sha256,
    )
    if args.transition == "roles-anywhere":
        assert crl_verifier_arguments is not None
        assert args.post_enable_crl_evidence is not None
        assert probe_arguments is not None
        assert args.post_enable_probe_evidence is not None
        validate_crl_verifier_arguments(
            crl_verifier_arguments,
            identity=current["identity"],
            stack_name=stack_match.group(4),
            region=args.region,
            aws_profile=args.aws_profile,
            evidence_path=args.post_enable_crl_evidence,
        )
        validate_probe_arguments(
            probe_arguments,
            identity=current["identity"],
            region=args.region,
            aws_binary=aws_binary,
            evidence_path=args.post_enable_probe_evidence,
            live_crl_evidence_path=args.post_enable_crl_evidence,
            owner_uid=args.expected_owner_uid,
            trust_boundary=args.trust_boundary,
        )
        binding = {
            **binding,
            "activationControl": {
                **activation_lease_budget(),
                "monitoringTimeInMinutes": ACTIVATION_MONITORING_MINUTES,
                "postEnableCrlVerifier": crl_control,
                "postEnableProbe": probe_control,
            },
        }
    if sha256_file(args.aws_config) != aws_config_sha256:
        fail("AWS config changed during inspection")
    if sha256_file(aws_binary) != aws_cli_sha256:
        fail("AWS CLI target changed during inspection")
    if args.bootstrap_receipt is not None and (
        sha256_file(args.bootstrap_receipt) != bootstrap_receipt_sha256
    ):
        fail("bootstrap receipt changed during inspection")
    if probe_executable is not None and (
        sha256_file(probe_executable) != args.post_enable_probe_bin_sha256
    ):
        fail("post-enable probe changed during inspection")
    if crl_verifier_executable is not None and (
        sha256_file(crl_verifier_executable)
        != args.post_enable_crl_verifier_bin_sha256
    ):
        fail("post-enable CRL verifier changed during inspection")
    if args.post_enable_crl_verifier_arguments is not None and (
        sha256_file(args.post_enable_crl_verifier_arguments)
        != args.post_enable_crl_verifier_arguments_sha256
    ):
        fail("post-enable CRL verifier arguments changed during inspection")
    if args.post_enable_probe_arguments is not None and (
        sha256_file(args.post_enable_probe_arguments)
        != args.post_enable_probe_arguments_sha256
    ):
        fail("post-enable probe arguments changed during inspection")
    if (
        canonical_json(
            load_reviewed_change_set(
                args.reviewed_change_set,
                args.reviewed_change_set_sha256,
            ),
        )
        != canonical_json(reviewed_change_set)
    ):
        fail("reviewed change-set file changed during inspection")

    if args.operation == "inspect":
        review_receipt = {
            **binding,
            "inspectedAt": datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
        }
        write_evidence(args.review_receipt, review_receipt)
        print(
            json.dumps(
                {
                    "ok": True,
                    "operation": "inspect",
                    "schemaVersion": SCHEMA,
                    "reviewReceiptSha256": sha256_file(args.review_receipt),
                },
                separators=(",", ":"),
                sort_keys=True,
            ),
        )
        return

    review_receipt = load_review_receipt(
        args.review_receipt,
        args.review_receipt_sha256,
    )
    if set(review_receipt) != {*binding, "inspectedAt"}:
        fail("review receipt fields do not match the exact schema")
    inspected_at = review_receipt.get("inspectedAt")
    if not isinstance(inspected_at, str) or re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z",
        inspected_at,
    ) is None:
        fail("review receipt inspectedAt is invalid")
    if {
        key: value
        for key, value in review_receipt.items()
        if key != "inspectedAt"
    } != binding:
        fail("current state or reviewed change set differs from the review receipt")

    client_token = (
        "nexus-dr-activation-"
        f"{args.review_receipt_sha256[:32]}"
    )

    assert args.journal is not None
    assert args.evidence_out is not None
    journal = {
        "schemaVersion": JOURNAL_SCHEMA,
        "phase": "prepared",
        "createdAt": utc_now(),
        "updatedAt": utc_now(),
        "stackId": args.stack_id,
        "changeSetId": args.change_set_id,
        "region": args.region,
        "transition": args.transition,
        "reviewReceiptSha256": args.review_receipt_sha256,
        "expectedTemplateSha256": args.expected_template_sha256,
        "reviewedChangeSetSha256": args.reviewed_change_set_sha256,
        "awsConfigSha256": aws_config_sha256,
        "awsCliSha256": aws_cli_sha256,
        "bootstrapReceiptSha256": bootstrap_receipt_sha256,
        "binding": binding,
        "current": current,
        "desiredParameters": desired_parameters,
        "desiredControls": desired_controls,
        "clientToken": client_token,
    }
    write_journal(
        args.journal,
        journal,
        owner_uid=args.expected_owner_uid,
        boundary=args.trust_boundary,
        create=True,
    )

    if args.transition == "roles-anywhere":
        assert crl_verifier_executable is not None
        assert crl_verifier_arguments is not None
        assert args.post_enable_crl_evidence is not None
        assert probe_executable is not None
        assert probe_arguments is not None
        assert args.post_enable_probe_evidence is not None
        journal = update_activation_journal(
            args.journal,
            journal,
            phase="priming-alarm",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        prime_activation_alarm(
            cli,
            alarm_arn=current["identity"]["rollbackAlarmArn"],
            stack_name=stack_match.group(4),
            timeout_seconds=args.alarm_prime_timeout_seconds,
            poll_seconds=args.poll_interval_seconds,
        )
        journal = update_activation_journal(
            args.journal,
            journal,
            phase="alarm-ok",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )

    if args.bootstrap_receipt is not None and (
        sha256_file(args.bootstrap_receipt) != bootstrap_receipt_sha256
    ):
        fail("bootstrap receipt changed immediately before execution")
    if probe_executable is not None and (
        sha256_file(probe_executable) != args.post_enable_probe_bin_sha256
    ):
        fail("post-enable probe changed immediately before execution")
    if crl_verifier_executable is not None and (
        sha256_file(crl_verifier_executable)
        != args.post_enable_crl_verifier_bin_sha256
    ):
        fail("post-enable CRL verifier changed immediately before execution")
    if args.post_enable_crl_verifier_arguments is not None and (
        sha256_file(args.post_enable_crl_verifier_arguments)
        != args.post_enable_crl_verifier_arguments_sha256
    ):
        fail("post-enable CRL verifier arguments changed immediately before execution")
    if args.post_enable_probe_arguments is not None and (
        sha256_file(args.post_enable_probe_arguments)
        != args.post_enable_probe_arguments_sha256
    ):
        fail("post-enable probe arguments changed immediately before execution")

    reverify_execution_authorization(
        cli=cli,
        transition=args.transition,
        stack_id=args.stack_id,
        change_set_id=args.change_set_id,
        template_digest=args.expected_template_sha256,
        bootstrap_receipt_sha256=bootstrap_receipt_sha256,
        partition=partition,
        region=args.region,
        account=account,
        current=current,
        reviewed_change_set=reviewed_change_set,
        reviewed_change_set_path=args.reviewed_change_set,
        reviewed_change_set_sha256=args.reviewed_change_set_sha256,
        review_receipt_path=args.review_receipt,
        review_receipt_sha256=args.review_receipt_sha256,
        binding=binding,
        aws_config=args.aws_config,
        aws_config_sha256=aws_config_sha256,
        aws_binary=aws_binary,
        aws_cli_sha256=aws_cli_sha256,
        lease_stack_name=(
            stack_match.group(4)
            if args.transition == "roles-anywhere"
            else None
        ),
    )
    journal = update_activation_journal(
        args.journal,
        journal,
        phase="authorization-reverified",
        owner_uid=args.expected_owner_uid,
        boundary=args.trust_boundary,
    )
    # Persist intent before the only mutating AWS call. If the process loses
    # the response, recovery inspects the exact stack and change set and never
    # repeats execute-change-set.
    journal = update_activation_journal(
        args.journal,
        journal,
        phase="execution-attempted",
        owner_uid=args.expected_owner_uid,
        boundary=args.trust_boundary,
    )
    cli.run(
        [
            "cloudformation",
            "execute-change-set",
            "--stack-name",
            args.stack_id,
            "--change-set-name",
            args.change_set_id,
            "--client-request-token",
            client_token,
        ],
        expect_json=False,
    )
    journal = update_activation_journal(
        args.journal,
        journal,
        phase="change-set-accepted",
        owner_uid=args.expected_owner_uid,
        boundary=args.trust_boundary,
    )

    if args.transition == "roles-anywhere":
        assert crl_verifier_executable is not None
        assert crl_verifier_arguments is not None
        assert args.post_enable_crl_evidence is not None
        assert probe_executable is not None
        assert probe_arguments is not None
        assert args.post_enable_probe_evidence is not None
        passed, _result = drive_roles_anywhere_activation(
            cli=cli,
            stack_id=args.stack_id,
            stack_name=stack_match.group(4),
            change_set_id=args.change_set_id,
            template_digest=args.expected_template_sha256,
            current=current,
            desired_parameters=desired_parameters,
            desired_controls=desired_controls,
            partition=partition,
            region=args.region,
            account=account,
            binding=binding,
            review_receipt_sha256=args.review_receipt_sha256,
            journal_path=args.journal,
            journal=journal,
            evidence_path=args.evidence_out,
            crl_verifier_executable=crl_verifier_executable,
            crl_verifier_arguments=crl_verifier_arguments,
            crl_evidence_path=args.post_enable_crl_evidence,
            probe_executable=probe_executable,
            probe_arguments=probe_arguments,
            probe_evidence_path=args.post_enable_probe_evidence,
            owner_uid=args.expected_owner_uid,
            trust_boundary=args.trust_boundary,
            wait_timeout_seconds=args.wait_timeout_seconds,
            poll_seconds=args.poll_interval_seconds,
        )
        print(json.dumps({
            "ok": passed,
            "operation": "execute",
            "schemaVersion": SCHEMA,
            "status": "passed" if passed else "rolled-back",
            "evidenceSha256": sha256_file(args.evidence_out),
        }, separators=(",", ":"), sort_keys=True))
        if not passed:
            fail("reviewed activation rolled back")
        return

    assert bootstrap_receipt_sha256 is not None
    passed, _result = drive_lifecycle_activation(
        cli=cli,
        stack_id=args.stack_id,
        change_set_id=args.change_set_id,
        template_digest=args.expected_template_sha256,
        current=current,
        desired_parameters=desired_parameters,
        desired_controls=desired_controls,
        partition=partition,
        region=args.region,
        account=account,
        binding=binding,
        review_receipt_sha256=args.review_receipt_sha256,
        bootstrap_receipt_sha256=bootstrap_receipt_sha256,
        journal_path=args.journal,
        journal=journal,
        evidence_path=args.evidence_out,
        owner_uid=args.expected_owner_uid,
        trust_boundary=args.trust_boundary,
        wait_timeout_seconds=args.wait_timeout_seconds,
        poll_seconds=args.poll_interval_seconds,
    )
    print(json.dumps({
        "ok": passed,
        "operation": "execute",
        "schemaVersion": SCHEMA,
        "status": "passed" if passed else "rolled-back",
        "evidenceSha256": sha256_file(args.evidence_out),
    }, separators=(",", ":"), sort_keys=True))
    if not passed:
        fail("reviewed activation rolled back")


if __name__ == "__main__":
    main()
