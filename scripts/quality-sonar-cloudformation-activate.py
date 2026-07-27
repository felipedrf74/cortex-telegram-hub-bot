#!/usr/bin/env python3
"""Inspect, execute, or recover one reviewed Sonar CloudFormation transition.

The controller is intentionally sequential.  During Roles Anywhere activation
it owns the only CloudWatch lease used by CloudFormation's rollback trigger.
There is no background heartbeat: every AWS call and credential probe is
bounded, and loss of this process therefore stops the lease.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import configparser
from datetime import datetime, timedelta, timezone
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


REVIEW_SCHEMA = "NexusSonarCloudFormationActivationReviewV1"
JOURNAL_SCHEMA = "NexusSonarCloudFormationActivationJournalV1"
RESULT_SCHEMA = "NexusSonarCloudFormationActivationResultV1"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SERIAL = re.compile(r"^[0-9A-Fa-f:]{1,512}$")
REGION = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]$")
PROFILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$")
STACK_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):cloudformation:"
    r"([a-z0-9-]+):([0-9]{12}):stack/"
    r"([A-Za-z][A-Za-z0-9-]{0,127})/"
    r"([A-Za-z0-9-]{1,128})$",
)
CHANGE_SET_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):cloudformation:"
    r"([a-z0-9-]+):([0-9]{12}):changeSet/"
    r"([A-Za-z0-9][-A-Za-z0-9_.]{0,127})/"
    r"([0-9a-f-]{36})$",
)
TRUST_ANCHOR_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:"
    r"([a-z0-9-]+):([0-9]{12}):trust-anchor/([0-9a-f-]{36})$",
)
PROFILE_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:"
    r"([a-z0-9-]+):([0-9]{12}):profile/([0-9a-f-]{36})$",
)
ROLE_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):"
    r"role/(?:[A-Za-z0-9+=,.@_-]+/)*[A-Za-z0-9+=,.@_-]{1,64}$",
)
ALARM_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):cloudwatch:"
    r"([a-z0-9-]+):([0-9]{12}):alarm:([A-Za-z0-9_.:/=+@-]{1,255})$",
)
MAX_JSON_BYTES = 8 * 1024 * 1024
MONITORING_MINUTES = 15
ALARM_PERIOD_SECONDS = 30
ALARM_EVALUATION_PERIODS = 4
METRIC_NAMESPACE = "Nexus/SonarQube"
LEASE_METRIC = "ActivationLease"
ACTIVE_UPDATE = {
    "UPDATE_IN_PROGRESS",
    "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
}
ACTIVE_ROLLBACK = {
    "UPDATE_ROLLBACK_IN_PROGRESS",
    "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
}
COMPLETE_PRIOR = {
    "CREATE_COMPLETE",
    "UPDATE_COMPLETE",
    "UPDATE_ROLLBACK_COMPLETE",
}
ACTIVATION_CHANGES = {
    "SonarBackupBucket": "AWS::S3::Bucket",
    "SonarBackupRole": "AWS::IAM::Role",
    "SonarRestoreRole": "AWS::IAM::Role",
    "SonarBackupRolesAnywhereProfile": "AWS::RolesAnywhere::Profile",
    "SonarRestoreRolesAnywhereProfile": "AWS::RolesAnywhere::Profile",
    "SonarRolesAnywhereTrustAnchor": "AWS::RolesAnywhere::TrustAnchor",
    "SonarRolesAnywhereCertificateRevocationList": "AWS::RolesAnywhere::CRL",
}
LIFECYCLE_CHANGES = {"SonarBackupBucket": "AWS::S3::Bucket"}


def fail(message: str, code: int = 1) -> NoReturn:
    raise SystemExit(code if message == "" else message)


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
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        fail(f"could not hash {path.name}: {error}")
    return digest.hexdigest()


def timestamp() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def precise_timestamp() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def parse_timestamp(value: Any, *, label: str) -> datetime:
    if not isinstance(value, str):
        fail(f"{label} is not a canonical UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(f"{label} is not a canonical UTC timestamp")
    if (
        parsed.tzinfo is None
        or parsed.utcoffset() != timezone.utc.utcoffset(parsed)
        or not value.endswith("Z")
    ):
        fail(f"{label} is not a canonical UTC timestamp")
    return parsed


def normalize_serial(value: str, *, label: str) -> str:
    if SERIAL.fullmatch(value) is None:
        fail(f"{label} is not a bounded hexadecimal certificate serial")
    compact = value.replace(":", "").lower().lstrip("0")
    return compact or "0"


def crl_serials(
    openssl_bin: Path,
    crl_data: bytes,
    *,
    timeout_seconds: int,
) -> set[str]:
    inform = "PEM" if crl_data.startswith(b"-----BEGIN X509 CRL-----") else "DER"
    try:
        result = subprocess.run(
            [
                str(openssl_bin),
                "crl",
                "-inform",
                inform,
                "-noout",
                "-text",
            ],
            check=False,
            capture_output=True,
            env={
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            },
            input=crl_data,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        fail("live Sonar CRL serial inspection exceeded its deadline")
    if (
        result.returncode != 0
        or len(result.stdout) > MAX_JSON_BYTES
        or result.stderr
    ):
        fail("OpenSSL could not inspect the exact live Sonar CRL")
    try:
        detail = result.stdout.decode("ascii")
    except UnicodeDecodeError:
        fail("OpenSSL returned non-ASCII live Sonar CRL detail")
    serials = {
        normalize_serial(match.group(1), label="live Sonar CRL serial")
        for match in re.finditer(
            r"^\s*Serial Number:\s*([0-9A-Fa-f:]{1,512})\s*$",
            detail,
            re.MULTILINE,
        )
    }
    if not serials:
        fail("live Sonar CRL contains no revoked certificate serial")
    return serials


def canonical_pem_crl_der(crl_data: bytes) -> bytes:
    begin = b"-----BEGIN X509 CRL-----\n"
    end = b"-----END X509 CRL-----\n"
    if not crl_data.startswith(begin) or not crl_data.endswith(end):
        fail("live Sonar CRL is not canonical PEM")
    encoded = crl_data[len(begin) : -len(end)]
    if not encoded.endswith(b"\n"):
        fail("live Sonar CRL PEM body is not canonical")
    encoded = encoded[:-1]
    lines = encoded.split(b"\n")
    if (
        not lines
        or any(not line or len(line) > 64 for line in lines)
        or any(len(line) != 64 for line in lines[:-1])
    ):
        fail("live Sonar CRL PEM body is not canonical")
    compact = b"".join(lines)
    try:
        der = base64.b64decode(compact, validate=True)
    except (ValueError, binascii.Error):
        fail("live Sonar CRL PEM body is invalid")
    encoded_der = base64.b64encode(der)
    canonical_lines = [
        encoded_der[index : index + 64]
        for index in range(0, len(encoded_der), 64)
    ]
    canonical = begin + b"\n".join(canonical_lines) + b"\n" + end
    if not der or canonical != crl_data:
        fail("live Sonar CRL PEM body is not canonical")
    return der


def trusted_file(
    path: Path,
    *,
    label: str,
    owner_uid: int,
    boundary: Path,
    private: bool = True,
    executable: bool = False,
) -> None:
    if not path.is_absolute() or path == Path("/"):
        fail(f"{label} must use an absolute non-root path")
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
    if metadata.st_uid != owner_uid or stat.S_IMODE(metadata.st_mode) & 0o022:
        fail(f"{label} has an untrusted owner or mode")
    if private and stat.S_IMODE(metadata.st_mode) & 0o077:
        fail(f"{label} must be owner-private")
    if executable and stat.S_IMODE(metadata.st_mode) & 0o111 == 0:
        fail(f"{label} must be executable")
    try:
        path.relative_to(canonical_boundary)
    except ValueError:
        fail(f"{label} is outside the trusted boundary")


def prepare_new_output(
    path: Path,
    *,
    label: str,
    owner_uid: int,
    boundary: Path,
) -> None:
    if not path.is_absolute() or path == Path("/") or path.exists() or path.is_symlink():
        fail(f"{label} must be a new absolute non-root path")
    parent = path.parent
    try:
        metadata = parent.lstat()
        canonical = parent.resolve(strict=True)
        canonical_boundary = boundary.resolve(strict=True)
    except OSError as error:
        fail(f"{label} parent is unavailable: {error}")
    if (
        canonical != parent
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != owner_uid
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        fail(f"{label} parent must be canonical, owner-private, and trusted")
    try:
        parent.relative_to(canonical_boundary)
    except ValueError:
        fail(f"{label} is outside the trusted boundary")


def atomic_write(path: Path, value: dict[str, Any], *, replace: bool) -> None:
    temporary = path.parent / f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = None
    try:
        descriptor = os.open(temporary, flags, 0o600)
        body = canonical_json(value) + b"\n"
        offset = 0
        while offset < len(body):
            written = os.write(descriptor, body[offset:])
            if written <= 0:
                fail("could not write complete Sonar activation evidence")
            offset += written
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path, follow_symlinks=False)
            temporary.unlink()
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as error:
        fail(f"could not persist Sonar activation evidence: {error}")
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def read_json(path: Path, *, label: str) -> dict[str, Any]:
    try:
        body = path.read_bytes()
    except OSError as error:
        fail(f"{label} is unreadable: {error}")
    if not 1 <= len(body) <= MAX_JSON_BYTES:
        fail(f"{label} size is invalid")
    try:
        value = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"{label} is invalid JSON: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must contain one JSON object")
    return value


def persist_or_validate_result(
    args: argparse.Namespace,
    result: dict[str, Any],
) -> dict[str, Any]:
    if not args.evidence_out.exists():
        atomic_write(args.evidence_out, result, replace=False)
        return result
    trusted_file(
        args.evidence_out,
        label="activation evidence",
        owner_uid=args.expected_owner_uid,
        boundary=args.trust_boundary,
    )
    existing = read_json(args.evidence_out, label="activation evidence")
    if (
        set(existing) != set(result)
        or {
            key: value for key, value in existing.items() if key != "observedAt"
        }
        != {
            key: value for key, value in result.items() if key != "observedAt"
        }
    ):
        fail("existing activation evidence does not match the exact result")
    try:
        observed = datetime.fromisoformat(
            str(existing["observedAt"]).replace("Z", "+00:00"),
        )
    except (KeyError, ValueError):
        fail("existing activation evidence timestamp is invalid")
    if observed.tzinfo is None or observed.utcoffset() != timezone.utc.utcoffset(observed):
        fail("existing activation evidence timestamp is not canonical UTC")
    return existing


def normalized_parameters(value: Any, *, label: str) -> dict[str, str]:
    if not isinstance(value, list):
        fail(f"{label} parameters are invalid")
    result: dict[str, str] = {}
    for entry in value:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("ParameterKey"), str)
            or not isinstance(entry.get("ParameterValue"), str)
            or entry["ParameterKey"] in result
            or entry.get("UsePreviousValue") is True
            or entry.get("ResolvedValue") not in {None, ""}
        ):
            fail(f"{label} parameters must be exact explicit string values")
        result[entry["ParameterKey"]] = entry["ParameterValue"]
    return dict(sorted(result.items()))


def normalized_named(value: Any, key: str, item: str, *, label: str) -> dict[str, str]:
    if not isinstance(value, list):
        fail(f"{label} is invalid")
    result: dict[str, str] = {}
    for entry in value:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get(key), str)
            or not isinstance(entry.get(item), str)
            or entry[key] in result
        ):
            fail(f"{label} contains an invalid or duplicate entry")
        result[entry[key]] = entry[item]
    return dict(sorted(result.items()))


def sanitize_owner_config(
    path: Path,
    profile: str,
    *,
    region: str,
    account: str,
) -> None:
    parser = configparser.RawConfigParser(interpolation=None)
    try:
        with path.open(encoding="utf-8") as source:
            parser.read_file(source)
    except (OSError, configparser.Error) as error:
        fail(f"owner AWS config is invalid: {error}")
    if parser.defaults():
        fail("owner AWS config must not define defaults")
    selected_name = f"profile {profile}"
    if selected_name not in parser:
        fail("owner AWS config is missing the exact selected profile")
    profile_sections = [name for name in parser.sections() if name.startswith("profile ")]
    if profile_sections != [selected_name]:
        fail("owner AWS config must contain exactly one purpose-built profile")
    selected = {key: value.strip() for key, value in parser[selected_name].items()}
    allowed = {
        "output",
        "region",
        "sso_account_id",
        "sso_region",
        "sso_role_name",
        "sso_session",
        "sso_start_url",
    }
    if (
        not set(selected).issubset(allowed)
        or selected.get("region") != region
        or selected.get("sso_account_id") != account
        or not selected.get("sso_role_name")
        or not (selected.get("sso_session") or selected.get("sso_start_url"))
    ):
        fail("owner AWS profile is not an exact short-lived SSO profile")
    forbidden = {
        "aws_access_key_id",
        "aws_secret_access_key",
        "aws_session_token",
        "credential_process",
        "credential_source",
        "endpoint_url",
        "role_arn",
        "source_profile",
        "web_identity_token_file",
    }
    for section in parser.sections():
        values = {key.lower() for key in parser[section]}
        if values & forbidden:
            fail("owner AWS config contains a forbidden credential or endpoint source")


class AwsCli:
    def __init__(
        self,
        *,
        binary: Path,
        config: Path,
        profile: str,
        region: str,
        timeout_seconds: int,
    ) -> None:
        self.binary = binary
        self.config = config
        self.profile = profile
        self.region = region
        self.timeout_seconds = timeout_seconds

    def environment(self, config: Path | None = None, profile: str | None = None) -> dict[str, str]:
        environment = {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": os.environ.get("HOME", "/root"),
            "AWS_CONFIG_FILE": str(config or self.config),
            "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
            "AWS_PROFILE": profile or self.profile,
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_PAGER": "",
        }
        return environment

    def run(
        self,
        arguments: list[str],
        *,
        label: str,
        expect_json: bool = True,
        config: Path | None = None,
        profile: str | None = None,
        allow_failure: bool = False,
    ) -> Any:
        command = [
            str(self.binary),
            "--no-cli-pager",
            "--region",
            self.region,
            "--profile",
            profile or self.profile,
            "--cli-connect-timeout",
            "5",
            "--cli-read-timeout",
            str(min(20, self.timeout_seconds)),
            *arguments,
        ]
        if expect_json:
            command.extend(["--output", "json"])
        try:
            result = subprocess.run(
                command,
                check=False,
                capture_output=True,
                env=self.environment(config, profile),
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            fail(f"{label} exceeded the sequential call deadline")
        if len(result.stdout) > MAX_JSON_BYTES or len(result.stderr) > MAX_JSON_BYTES:
            fail(f"{label} exceeded the bounded output limit")
        if result.returncode != 0:
            if allow_failure:
                return result
            fail(f"{label} failed without persisting raw AWS output")
        if not expect_json:
            return None
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            fail(f"{label} returned invalid JSON")


def verify_signed_transition(args: argparse.Namespace, *, allow_expired: bool) -> dict[str, Any]:
    kind = "activation" if args.transition == "roles-anywhere" else "lifecycle"
    command = [
        str(args.node_bin),
        str(args.receipt_helper),
        "verify-transition",
        "--kind",
        kind,
        "--input",
        str(args.transition_receipt),
        "--receipt",
        str(args.base_receipt),
        "--public-key",
        str(args.public_key),
        "--key-id",
        args.key_id,
    ]
    if allow_expired:
        command.append("--allow-expired")
    if args.transition == "lifecycle":
        command.extend(["--backup-success-receipt", str(args.backup_success_receipt)])
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            env={
                "HOME": os.environ.get("HOME", "/root"),
                "NODE_ENV": "production",
                "PATH":
                    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "TZ": "UTC",
            },
            timeout=args.command_timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        fail("signed transition verification exceeded its deadline")
    if len(result.stdout) > MAX_JSON_BYTES or len(result.stderr) > MAX_JSON_BYTES:
        fail("signed transition verification exceeded its bounded output limit")
    if result.returncode != 0:
        fail("signed transition authorization is invalid or expired")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail("signed transition verifier returned invalid JSON")
    if (
        value.get("ok") is not True
        or value.get("kind") != "transition"
        or value.get("transitionKind") != kind
        or not SHA256.fullmatch(value.get("receiptSha256", ""))
    ):
        fail("signed transition verifier returned invalid evidence")
    return value


def normalized_rollback(value: Any) -> dict[str, Any]:
    if value is None:
        value = {}
    if not isinstance(value, dict) or not set(value).issubset(
        {"RollbackTriggers", "MonitoringTimeInMinutes"},
    ):
        fail("change-set rollback configuration is invalid")
    triggers = value.get("RollbackTriggers", [])
    monitoring = value.get("MonitoringTimeInMinutes", 0)
    if not isinstance(triggers, list) or not isinstance(monitoring, int):
        fail("change-set rollback configuration is invalid")
    normalized = []
    for trigger in triggers:
        if (
            not isinstance(trigger, dict)
            or set(trigger) != {"Arn", "Type"}
            or trigger.get("Type") != "AWS::CloudWatch::Alarm"
            or not isinstance(trigger.get("Arn"), str)
        ):
            fail("change-set rollback trigger is invalid")
        normalized.append({"Arn": trigger["Arn"], "Type": trigger["Type"]})
    return {
        "rollbackTriggers": sorted(normalized, key=lambda entry: entry["Arn"]),
        "monitoringTimeInMinutes": monitoring,
    }


def validate_changes(value: Any, transition: str) -> list[dict[str, str]]:
    expected = ACTIVATION_CHANGES if transition == "roles-anywhere" else LIFECYCLE_CHANGES
    if not isinstance(value, list):
        fail("change-set resource inventory is invalid")
    observed: dict[str, str] = {}
    for change in value:
        resource = change.get("ResourceChange") if isinstance(change, dict) else None
        if (
            change.get("Type") != "Resource"
            or not isinstance(resource, dict)
            or resource.get("Action") != "Modify"
            or resource.get("Replacement") not in {None, "False", False}
            or resource.get("LogicalResourceId") in observed
        ):
            fail("change set contains a non-allowlisted resource operation")
        logical = resource.get("LogicalResourceId")
        resource_type = resource.get("ResourceType")
        if expected.get(logical) != resource_type:
            fail("change set contains a resource outside the exact transition allowlist")
        observed[logical] = resource_type
    if observed != expected:
        fail("change set does not contain the exact transition resource allowlist")
    return [
        {"logicalResourceId": key, "resourceType": observed[key]}
        for key in sorted(observed)
    ]


def validate_parameter_transition(
    *,
    current: dict[str, str],
    desired: dict[str, str],
    transition: str,
    receipt: dict[str, Any],
    expected_template_sha256: str,
    allow_executed: bool,
) -> dict[str, str]:
    payload = receipt["payload"]
    prior = payload["transition"]["priorStack"]
    base_digest = payload["receiptSha256"]
    governed_prior = {
        "LifecycleActivation": prior["lifecycleActivation"],
        "LifecycleBootstrapReceiptSha256": prior["lifecycleBootstrapReceiptSha256"],
        "OwnerReceiptKeyId": prior["ownerReceiptKeyId"],
        "OwnerReceiptPublicKeySha256": prior["ownerReceiptPublicKeySha256"],
        "ProtectedMainTemplateSha256": prior["protectedMainTemplateSha256"],
        "RolesAnywhereActivation": prior["rolesAnywhereActivation"],
        "RolesAnywhereActivationReceiptSha256":
            prior["rolesAnywhereActivationReceiptSha256"],
    }
    prior_parameters = dict(desired)
    for key, value in governed_prior.items():
        prior_parameters[key] = value
    if prior_parameters.get("ProtectedMainTemplateSha256") != expected_template_sha256:
        fail("signed prior stack is not bound to the expected protected-main template")
    expected = dict(prior_parameters)
    if transition == "roles-anywhere":
        expected["RolesAnywhereActivation"] = "ENABLED"
        expected["RolesAnywhereActivationReceiptSha256"] = base_digest
    else:
        expected["LifecycleActivation"] = "ENABLED"
        expected["LifecycleBootstrapReceiptSha256"] = base_digest
    if desired != expected:
        fail("change-set parameters are not the exact explicit transition")
    if current != prior_parameters and not (allow_executed and current == desired):
        fail("live stack parameters are neither the exact prior nor executed state")
    return prior_parameters


def inspect_binding(
    args: argparse.Namespace,
    cli: AwsCli,
    receipt: dict[str, Any],
    *,
    allow_executed: bool,
) -> tuple[dict[str, Any], dict[str, str], dict[str, str], dict[str, Any]]:
    payload = receipt["payload"]
    stack_payload = payload["stack"]
    transition = payload["transition"]
    if (
        transition.get("changeSetId") != args.change_set_id
        or stack_payload.get("name") != args.stack_name
        or stack_payload.get("region") != args.region
        or stack_payload.get("accountId") != args.account
        or stack_payload.get("templateSha256") != args.expected_template_sha256
    ):
        fail("signed transition does not bind the exact selected stack and change set")
    identity = cli.run(["sts", "get-caller-identity"], label="owner caller identity")
    arn_digest = sha256_bytes(str(identity.get("Arn", "")).encode())
    user_digest = sha256_bytes(str(identity.get("UserId", "")).encode())
    if (
        identity.get("Account") != args.account
        or arn_digest != transition.get("executorArnSha256")
        or user_digest != transition.get("executorUserIdSha256")
    ):
        fail("owner AWS profile is not the exact signed executor")
    described = cli.run(
        ["cloudformation", "describe-stacks", "--stack-name", args.stack_id],
        label="Sonar stack",
    )
    if (
        described.get("NextToken") is not None
        or not isinstance(described.get("Stacks"), list)
        or len(described["Stacks"]) != 1
    ):
        fail("Sonar stack response is incomplete or ambiguous")
    stack = described["Stacks"][0]
    allowed_stack_statuses = (
        COMPLETE_PRIOR | ACTIVE_UPDATE | ACTIVE_ROLLBACK
        if allow_executed
        else COMPLETE_PRIOR
    )
    if (
        stack.get("StackId") != args.stack_id
        or stack.get("StackName") != args.stack_name
        or stack.get("StackStatus") not in allowed_stack_statuses
        or stack.get("EnableTerminationProtection") is not True
        or stack.get("DisableRollback") not in {None, False}
    ):
        fail("Sonar stack identity, status, rollback, or termination protection is unsafe")
    current_parameters = normalized_parameters(
        stack.get("Parameters"),
        label="current stack",
    )
    outputs = normalized_named(
        stack.get("Outputs"),
        "OutputKey",
        "OutputValue",
        label="stack outputs",
    )
    change_set = cli.run(
        [
            "cloudformation",
            "describe-change-set",
            "--stack-name",
            args.stack_id,
            "--change-set-name",
            args.change_set_id,
            "--include-property-values",
        ],
        label="Sonar change set",
    )
    allowed_execution = {"AVAILABLE"}
    if allow_executed:
        allowed_execution |= {"EXECUTE_IN_PROGRESS", "EXECUTE_COMPLETE", "OBSOLETE"}
    if (
        change_set.get("NextToken") is not None
        or change_set.get("ChangeSetId") != args.change_set_id
        or change_set.get("StackId") != args.stack_id
        or change_set.get("StackName") != args.stack_name
        or change_set.get("ChangeSetType") != "UPDATE"
        or change_set.get("Status") != "CREATE_COMPLETE"
        or change_set.get("ExecutionStatus") not in allowed_execution
        or change_set.get("IncludeNestedStacks") not in {None, False}
        or change_set.get("ImportExistingResources") not in {None, False}
        or change_set.get("OnStackFailure") not in {None, "ROLLBACK"}
        or sorted(change_set.get("Capabilities", [])) != ["CAPABILITY_IAM"]
    ):
        fail("change set identity or execution controls are outside the allowlist")
    desired_parameters = normalized_parameters(
        change_set.get("Parameters"),
        label="change set",
    )
    prior_parameters = validate_parameter_transition(
        current=current_parameters,
        desired=desired_parameters,
        transition=args.transition,
        receipt=receipt,
        expected_template_sha256=args.expected_template_sha256,
        allow_executed=allow_executed,
    )
    alarm_arn = outputs.get("RolesAnywhereActivationRollbackAlarmArn", "")
    alarm_match = ALARM_ARN.fullmatch(alarm_arn)
    if (
        alarm_match is None
        or alarm_match.group(2) != args.region
        or alarm_match.group(3) != args.account
    ):
        fail("stack rollback alarm output is invalid")
    expected_rollback = (
        {
            "rollbackTriggers": [
                {"Arn": alarm_arn, "Type": "AWS::CloudWatch::Alarm"},
            ],
            "monitoringTimeInMinutes": MONITORING_MINUTES,
        }
        if args.transition == "roles-anywhere"
        else {"rollbackTriggers": [], "monitoringTimeInMinutes": 0}
    )
    if normalized_rollback(change_set.get("RollbackConfiguration")) != expected_rollback:
        fail("change set does not use the exact transition rollback configuration")
    notification_arns = sorted(change_set.get("NotificationARNs", []))
    if notification_arns != sorted(stack.get("NotificationARNs", [])):
        fail("change set changes stack notification controls")
    if change_set.get("RoleARN") != stack.get("RoleARN"):
        fail("change set changes the CloudFormation execution role")
    if sorted(change_set.get("Tags", []), key=lambda item: item.get("Key", "")) != sorted(
        stack.get("Tags", []),
        key=lambda item: item.get("Key", ""),
    ):
        fail("change set changes stack-level tags")
    changes = validate_changes(change_set.get("Changes"), args.transition)
    remote_template = cli.run(
        [
            "cloudformation",
            "get-template",
            "--stack-name",
            args.stack_id,
            "--change-set-name",
            args.change_set_id,
            "--template-stage",
            "Original",
        ],
        label="change-set template",
    )
    if (
        not isinstance(remote_template.get("TemplateBody"), str)
        or sha256_bytes(remote_template["TemplateBody"].encode())
        != args.expected_template_sha256
    ):
        fail("change-set template bytes differ from protected main")
    binding = {
        "schemaVersion": REVIEW_SCHEMA,
        "transition": args.transition,
        "region": args.region,
        "accountId": args.account,
        "stackId": args.stack_id,
        "stackName": args.stack_name,
        "changeSetId": args.change_set_id,
        "signedTransitionReceiptSha256": receipt["receiptSha256"],
        "baseReceiptSha256": payload["receiptSha256"],
        "expectedTemplateSha256": args.expected_template_sha256,
        "currentParametersSha256": sha256_bytes(canonical_json(prior_parameters)),
        "desiredParametersSha256": sha256_bytes(canonical_json(desired_parameters)),
        "resourceChanges": changes,
        "rollbackConfiguration": expected_rollback,
        "terminationProtectionVerified": True,
        "rollbackEnabled": True,
        "executorArnSha256": arn_digest,
        "executorUserIdSha256": user_digest,
        "ownerAwsConfigSha256": sha256_file(args.aws_config),
        "awsCliSha256": sha256_file(args.aws_bin),
    }
    reconciliation = {
        "changeSetExecutionStatus": change_set["ExecutionStatus"],
        "executionAccepted": (
            change_set["ExecutionStatus"] in {"EXECUTE_IN_PROGRESS", "EXECUTE_COMPLETE"}
            or stack["StackStatus"] in ACTIVE_UPDATE | ACTIVE_ROLLBACK
            or stack["StackStatus"] == "UPDATE_ROLLBACK_COMPLETE"
            or current_parameters == desired_parameters
        ),
        "stackStatus": stack["StackStatus"],
    }
    return binding, prior_parameters, outputs, reconciliation


def describe_alarm(cli: AwsCli, alarm_arn: str, stack_name: str) -> str:
    alarm_name = ALARM_ARN.fullmatch(alarm_arn).group(4)
    response = cli.run(
        ["cloudwatch", "describe-alarms", "--alarm-names", alarm_name],
        label="activation rollback alarm",
    )
    alarms = response.get("MetricAlarms")
    if not isinstance(alarms, list) or len(alarms) != 1:
        fail("CloudWatch did not return the exact rollback alarm")
    alarm = alarms[0]
    dimensions = alarm.get("Dimensions")
    if (
        alarm.get("AlarmArn") != alarm_arn
        or alarm.get("AlarmName") != alarm_name
        or alarm.get("ComparisonOperator") != "LessThanThreshold"
        or alarm.get("DatapointsToAlarm") != ALARM_EVALUATION_PERIODS
        or alarm.get("EvaluationPeriods") != ALARM_EVALUATION_PERIODS
        or alarm.get("MetricName") != LEASE_METRIC
        or alarm.get("Namespace") != METRIC_NAMESPACE
        or alarm.get("Period") != ALARM_PERIOD_SECONDS
        or alarm.get("Statistic") != "Minimum"
        or alarm.get("Threshold") != 1
        or alarm.get("TreatMissingData") != "breaching"
        or alarm.get("Unit") != "Count"
        or dimensions != [{"Name": "StackName", "Value": stack_name}]
        or alarm.get("StateValue") not in {"OK", "ALARM", "INSUFFICIENT_DATA"}
    ):
        fail("activation rollback alarm differs from the reviewed static control")
    return alarm["StateValue"]


def heartbeat(cli: AwsCli, stack_name: str) -> None:
    cli.run(
        [
            "cloudwatch",
            "put-metric-data",
            "--namespace",
            METRIC_NAMESPACE,
            "--metric-data",
            (
                f"MetricName={LEASE_METRIC},Dimensions=[{{Name=StackName,"
                f"Value={stack_name}}}],Value=1,Unit=Count,StorageResolution=1"
            ),
        ],
        label="activation lease renewal",
        expect_json=False,
    )


def prime_alarm(
    args: argparse.Namespace,
    cli: AwsCli,
    receipt: dict[str, Any],
    alarm_arn: str,
    stack_name: str,
) -> None:
    if describe_alarm(cli, alarm_arn, stack_name) != "ALARM":
        fail("rollback alarm must age to ALARM before exact approval is exercised")
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        rechecked = verify_signed_transition(args, allow_expired=False)
        if rechecked != receipt:
            fail("signed transition changed before activation lease mutation")
        require_mutation_authorization_margin(args, rechecked)
        heartbeat(cli, stack_name)
        time.sleep(5)
        if describe_alarm(cli, alarm_arn, stack_name) == "OK":
            return
    fail("rollback alarm did not become OK inside the 90-second provisioning bound")


def validate_identity_plane(
    cli: AwsCli,
    *,
    parameters: dict[str, str],
    outputs: dict[str, str],
    enabled: bool,
    openssl_bin: Path,
    lease_stack_name: str | None = None,
) -> set[str]:
    trust_match = TRUST_ANCHOR_ARN.fullmatch(outputs.get("RolesAnywhereTrustAnchorArn", ""))
    backup_match = PROFILE_ARN.fullmatch(outputs.get("BackupRolesAnywhereProfileArn", ""))
    restore_match = PROFILE_ARN.fullmatch(outputs.get("RestoreRolesAnywhereProfileArn", ""))
    if not trust_match or not backup_match or not restore_match:
        fail("Roles Anywhere output identities are invalid")
    anchor = cli.run(
        ["rolesanywhere", "get-trust-anchor", "--trust-anchor-id", trust_match.group(4)],
        label="Sonar trust anchor",
    ).get("trustAnchor")
    if lease_stack_name is not None:
        heartbeat(cli, lease_stack_name)
    if (
        not isinstance(anchor, dict)
        or anchor.get("trustAnchorArn") != outputs["RolesAnywhereTrustAnchorArn"]
        or anchor.get("enabled") is not enabled
        or anchor.get("source", {}).get("sourceType") != "CERTIFICATE_BUNDLE"
        or anchor.get("source", {}).get("sourceData", {}).get("x509CertificateData")
        != parameters.get("TrustAnchorCertificateData")
    ):
        fail("live Sonar trust anchor identity, certificate, or state is mismatched")
    crl_id = outputs.get("RolesAnywhereCrlId", "")
    crl = cli.run(
        ["rolesanywhere", "get-crl", "--crl-id", crl_id],
        label="Sonar certificate revocation list",
    ).get("crl")
    if lease_stack_name is not None:
        heartbeat(cli, lease_stack_name)
    if not isinstance(crl, dict):
        fail("live Sonar CRL identity, bytes, or state is mismatched")
    try:
        live_crl = base64.b64decode(crl.get("crlData", ""), validate=True)
    except (TypeError, ValueError, binascii.Error):
        fail("live Sonar CRL data is invalid")
    parameter_crl = parameters.get("CertificateRevocationListData")
    if not isinstance(parameter_crl, str):
        fail("CloudFormation Sonar CRL data is invalid")
    try:
        expected_crl = parameter_crl.encode("ascii")
    except UnicodeEncodeError:
        fail("CloudFormation Sonar CRL data is invalid")
    live_crl_der = canonical_pem_crl_der(live_crl)
    if (
        crl.get("crlId") != crl_id
        or crl.get("trustAnchorArn") != outputs["RolesAnywhereTrustAnchorArn"]
        or crl.get("enabled") is not enabled
        or live_crl != expected_crl
        or sha256_bytes(live_crl_der)
        != parameters.get("CertificateRevocationListSha256")
        or outputs.get("RolesAnywhereCrlSha256")
        != parameters.get("CertificateRevocationListSha256")
    ):
        fail("live Sonar CRL identity, bytes, or state is mismatched")
    revoked_serials = crl_serials(
        openssl_bin,
        live_crl,
        timeout_seconds=cli.timeout_seconds,
    )
    for kind, match, role_key in (
        ("backup", backup_match, "BackupPrincipalArn"),
        ("restore", restore_match, "RestorePrincipalArn"),
    ):
        profile = cli.run(
            ["rolesanywhere", "get-profile", "--profile-id", match.group(4)],
            label=f"Sonar {kind} profile",
        ).get("profile")
        if lease_stack_name is not None:
            heartbeat(cli, lease_stack_name)
        if (
            not isinstance(profile, dict)
            or profile.get("profileArn") != outputs[
                "BackupRolesAnywhereProfileArn"
                if kind == "backup"
                else "RestoreRolesAnywhereProfileArn"
            ]
            or profile.get("enabled") is not enabled
            or profile.get("durationSeconds") != 900
            or profile.get("roleArns") != [outputs[role_key]]
        ):
            fail(f"live Sonar {kind} profile identity or state is mismatched")
    return revoked_serials


def run_boundary(
    args: argparse.Namespace,
    cli: AwsCli,
    *,
    profile: str,
    role_arn: str,
    trust_anchor_arn: str,
    profile_arn: str,
) -> dict[str, Any]:
    command = [
        str(args.python_bin),
        str(args.credential_boundary_helper),
        "--config",
        str(args.probe_aws_config),
        "--profile",
        profile,
        "--region",
        args.region,
        "--helper",
        str(args.aws_signing_helper),
        "--helper-sha256",
        args.aws_signing_helper_sha256,
        "--expected-role-arn",
        role_arn,
        "--expected-trust-anchor-arn",
        trust_anchor_arn,
        "--expected-profile-arn",
        profile_arn,
        "--openssl-bin",
        str(args.openssl_bin),
        "--expected-owner-uid",
        str(args.expected_owner_uid),
        "--trust-boundary",
        str(args.trust_boundary),
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            env=cli.environment(args.probe_aws_config, profile),
            timeout=args.command_timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        fail(f"{profile} credential-boundary verification exceeded its deadline")
    if result.returncode != 0:
        fail(f"{profile} credential-boundary verification failed")
    try:
        evidence = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail(f"{profile} credential-boundary verification returned invalid JSON")
    if (
        not isinstance(evidence, dict)
        or set(evidence) != {
            "credentialSource",
            "certificateSerial",
            "helperSha256",
            "longLivedEnvironmentRejected",
            "profile",
            "profileArn",
            "region",
            "roleArn",
            "schemaVersion",
            "sharedCredentialsDisabled",
            "status",
            "trustAnchorArn",
        }
        or evidence.get("schemaVersion") != "NexusAwsCredentialProcessBoundaryV1"
        or evidence.get("status") != "passed"
        or evidence.get("profile") != profile
        or evidence.get("region") != args.region
        or evidence.get("helperSha256") != args.aws_signing_helper_sha256
        or evidence.get("credentialSource")
        != "iam-roles-anywhere-credential-process"
        or not isinstance(evidence.get("certificateSerial"), str)
        or normalize_serial(
            evidence["certificateSerial"],
            label=f"{profile} certificate serial",
        )
        != evidence["certificateSerial"]
        or evidence.get("profileArn") != profile_arn
        or evidence.get("roleArn") != role_arn
        or evidence.get("trustAnchorArn") != trust_anchor_arn
        or evidence.get("longLivedEnvironmentRejected") is not True
        or evidence.get("sharedCredentialsDisabled") is not True
    ):
        fail(f"{profile} credential-boundary evidence is mismatched")
    return evidence


def validate_probe_certificates(
    boundary_evidence: dict[str, dict[str, Any]],
    *,
    positive_profile: str,
    revoked_profile: str,
    revoked_serials: set[str],
) -> None:
    positive_serial = boundary_evidence[positive_profile]["certificateSerial"]
    revoked_serial = boundary_evidence[revoked_profile]["certificateSerial"]
    if (
        positive_serial == revoked_serial
        or positive_serial in revoked_serials
        or revoked_serial not in revoked_serials
    ):
        fail("positive and revoked probe certificates do not match the exact live CRL")


def validate_revoked_denial(result: subprocess.CompletedProcess[bytes]) -> None:
    if result.returncode == 0:
        fail("revoked certificate unexpectedly obtained AWS credentials")
    denial = result.stderr.decode("utf-8", errors="replace").lower()
    if (
        result.returncode is None
        or result.stdout.strip()
        or not denial.strip()
        or "certif" not in denial
        or "revok" not in denial
        or not any(marker in denial for marker in ("accessdenied", "access denied", "403"))
        or not any(
            marker in denial
            for marker in ("iam roles anywhere", "rolesanywhere", "createsession")
        )
    ):
        fail("revoked-certificate probe did not fail as a bounded credential denial")


def run_activation_probes(
    args: argparse.Namespace,
    cli: AwsCli,
    outputs: dict[str, str],
    revoked_serials: set[str],
) -> dict[str, Any]:
    boundary_evidence = {}
    for profile in (args.backup_probe_profile, args.revoked_probe_profile):
        boundary_evidence[profile] = run_boundary(
            args,
            cli,
            profile=profile,
            role_arn=outputs["BackupPrincipalArn"],
            trust_anchor_arn=outputs["RolesAnywhereTrustAnchorArn"],
            profile_arn=outputs["BackupRolesAnywhereProfileArn"],
        )
        heartbeat(cli, args.stack_name)
    validate_probe_certificates(
        boundary_evidence,
        positive_profile=args.backup_probe_profile,
        revoked_profile=args.revoked_probe_profile,
        revoked_serials=revoked_serials,
    )
    identity = cli.run(
        ["sts", "get-caller-identity"],
        label="positive Roles Anywhere credential probe",
        config=args.probe_aws_config,
        profile=args.backup_probe_profile,
    )
    heartbeat(cli, args.stack_name)
    role_name = outputs["BackupPrincipalArn"].rsplit("/", 1)[-1]
    if (
        identity.get("Account") != args.account
        or not re.fullmatch(
            rf"arn:(aws|aws-us-gov|aws-cn):sts::{args.account}:"
            rf"assumed-role/{re.escape(role_name)}/[^/]+",
            str(identity.get("Arn", "")),
        )
    ):
        fail("positive Roles Anywhere probe returned an unexpected principal")
    listing = cli.run(
        [
            "s3api",
            "list-objects-v2",
            "--bucket",
            outputs["BucketName"],
            "--prefix",
            f"{outputs['SonarPrefix']}/",
            "--max-keys",
            "1",
            "--expected-bucket-owner",
            args.account,
        ],
        label="positive Sonar prefix listing probe",
        config=args.probe_aws_config,
        profile=args.backup_probe_profile,
    )
    heartbeat(cli, args.stack_name)
    if not isinstance(listing.get("KeyCount"), int):
        fail("positive Sonar prefix listing probe returned invalid evidence")
    revoked = cli.run(
        ["sts", "get-caller-identity"],
        label="revoked-certificate credential probe",
        config=args.probe_aws_config,
        profile=args.revoked_probe_profile,
        allow_failure=True,
    )
    heartbeat(cli, args.stack_name)
    validate_revoked_denial(revoked)
    post_denial_identity = cli.run(
        ["sts", "get-caller-identity"],
        label="post-denial positive Roles Anywhere credential probe",
        config=args.probe_aws_config,
        profile=args.backup_probe_profile,
    )
    heartbeat(cli, args.stack_name)
    if (
        post_denial_identity.get("Account") != args.account
        or not re.fullmatch(
            rf"arn:(aws|aws-us-gov|aws-cn):sts::{args.account}:"
            rf"assumed-role/{re.escape(role_name)}/[^/]+",
            str(post_denial_identity.get("Arn", "")),
        )
    ):
        fail("post-denial positive probe returned an unexpected principal")
    return {
        "positiveCredentialBoundaryPassed":
            boundary_evidence[args.backup_probe_profile]["status"] == "passed",
        "revokedCredentialBoundaryPassed":
            boundary_evidence[args.revoked_probe_profile]["status"] == "passed",
        "exactProbeIdentityBindingsPassed": True,
        "revokedCertificateSerialInLiveCrl": True,
        "revocationDenialClassified": True,
        "positiveCredentialsPassed": True,
        "exactPrefixListingPassed": True,
        "revokedCertificateDenied": True,
        "revokedCredentialProcessFailed": True,
        "postDenialPositiveCredentialsPassed": True,
        "credentialsPersisted": False,
        "rawAwsResponsesPersisted": False,
    }


def lifecycle_state(cli: AwsCli, bucket: str, prefix: str, enabled: bool) -> None:
    response = cli.run(
        [
            "s3api",
            "get-bucket-lifecycle-configuration",
            "--bucket",
            bucket,
        ],
        label="Sonar bucket lifecycle",
    )
    rules = {entry.get("ID"): entry for entry in response.get("Rules", [])}
    expected = {
        "SonarDailyNoncurrentVersionRetention": (f"{prefix}/daily/", 35),
        "SonarWeeklyNoncurrentVersionRetention": (f"{prefix}/weekly/", 120),
    }
    for name, (rule_prefix, days) in expected.items():
        rule = rules.get(name)
        if (
            not isinstance(rule, dict)
            or rule.get("Status") != ("Enabled" if enabled else "Disabled")
            or rule.get("Prefix") != rule_prefix
            or rule.get("NoncurrentVersionExpiration", {}).get("NoncurrentDays") != days
        ):
            fail(f"Sonar lifecycle rule {name} is mismatched")


def write_journal(
    args: argparse.Namespace,
    journal: dict[str, Any],
    *,
    create: bool,
) -> None:
    if create:
        prepare_new_output(
            args.journal,
            label="activation journal",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
    else:
        trusted_file(
            args.journal,
            label="activation journal",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
    atomic_write(args.journal, journal, replace=not create)


def update_journal(
    args: argparse.Namespace,
    journal: dict[str, Any],
    phase: str,
    **extra: Any,
) -> dict[str, Any]:
    updated = {**journal, "phase": phase, "updatedAt": timestamp(), **extra}
    write_journal(args, updated, create=False)
    return updated


def execution_token(args: argparse.Namespace) -> str:
    return f"nexus-sonar-transition-{args.review_receipt_sha256[:32]}"


def require_mutation_authorization_margin(
    args: argparse.Namespace,
    receipt: dict[str, Any],
    *,
    additional_seconds: int = 0,
    include_final_verification: bool = False,
    observed_at: datetime | None = None,
) -> None:
    expires_at = parse_timestamp(
        receipt.get("payload", {}).get("expiresAt"),
        label="signed transition expiresAt",
    )
    now = observed_at or datetime.now(timezone.utc)
    if additional_seconds < 0:
        fail("authorization lifetime margin cannot be negative")
    minimum_seconds = (
        max(60, args.command_timeout_seconds * 2 + 10)
        + additional_seconds
    )
    if include_final_verification:
        minimum_seconds += args.command_timeout_seconds + 5
    minimum_margin = timedelta(seconds=minimum_seconds)
    if expires_at <= now:
        fail("signed transition authorization expired before AWS mutation")
    if expires_at - now <= minimum_margin:
        fail(
            "signed transition authorization has insufficient remaining "
            "lifetime for the bounded AWS mutation",
        )


def execute_exact_change_set(
    args: argparse.Namespace,
    cli: AwsCli,
    journal: dict[str, Any],
    receipt: dict[str, Any],
) -> dict[str, Any]:
    pre_journal_recheck = verify_signed_transition(args, allow_expired=False)
    if pre_journal_recheck != receipt:
        fail("signed transition changed before exact change-set execution")
    require_mutation_authorization_margin(
        args,
        pre_journal_recheck,
        include_final_verification=True,
    )
    client_token = execution_token(args)
    journal = update_journal(
        args,
        journal,
        "change-set-execution-attempted",
        executionAttempted=True,
        executionAttemptedAt=precise_timestamp(),
        authorizationReverifiedReceiptSha256=receipt["receiptSha256"],
        clientRequestTokenSha256=sha256_bytes(client_token.encode()),
    )
    final_recheck = verify_signed_transition(args, allow_expired=False)
    if final_recheck != receipt:
        fail("signed transition changed before exact change-set execution")
    require_mutation_authorization_margin(args, final_recheck)
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
        label="exact Sonar change-set execution",
        expect_json=False,
    )
    return update_journal(
        args,
        journal,
        "change-set-executed",
        executed=True,
    )


def reconcile_execution(
    args: argparse.Namespace,
    journal: dict[str, Any],
    reconciliation: dict[str, Any],
    receipt: dict[str, Any],
) -> dict[str, Any]:
    client_token_sha256 = sha256_bytes(execution_token(args).encode())
    if (
        journal.get("schemaVersion") != JOURNAL_SCHEMA
        or journal.get("transition") != args.transition
        or journal.get("stackId") != args.stack_id
        or journal.get("reviewReceiptSha256") != args.review_receipt_sha256
        or journal.get("changeSetId") != args.change_set_id
        or journal.get("executionAttempted") is not True
        or journal.get("clientRequestTokenSha256") != client_token_sha256
        or journal.get("authorizationReverifiedReceiptSha256")
        != receipt.get("receiptSha256")
        or journal.get("signedTransitionReceiptSha256")
        != receipt.get("receiptSha256")
        or not isinstance(journal.get("executionAttemptedAt"), str)
        or journal.get("executed") not in {False, True}
    ):
        fail("activation journal does not authorize recovery")
    attempted_at = parse_timestamp(
        journal["executionAttemptedAt"],
        label="journal executionAttemptedAt",
    )
    issued_at = parse_timestamp(
        receipt.get("payload", {}).get("issuedAt"),
        label="signed transition issuedAt",
    )
    expires_at = parse_timestamp(
        receipt.get("payload", {}).get("expiresAt"),
        label="signed transition expiresAt",
    )
    if attempted_at < issued_at or attempted_at > expires_at:
        fail("journaled execution attempt is outside signed authorization")
    if journal["executed"]:
        return journal
    if reconciliation.get("executionAccepted") is not True:
        fail("CloudFormation did not accept the journaled change-set execution attempt")
    return update_journal(
        args,
        journal,
        "change-set-execution-reconciled",
        executed=True,
        executionReconciled=True,
        reconciledChangeSetExecutionStatus=reconciliation["changeSetExecutionStatus"],
        reconciledStackStatus=reconciliation["stackStatus"],
    )


def validate_unattempted_execution(
    args: argparse.Namespace,
    journal: dict[str, Any],
    reconciliation: dict[str, Any],
    receipt: dict[str, Any],
) -> None:
    base_keys = {
        "schemaVersion",
        "phase",
        "createdAt",
        "updatedAt",
        "transition",
        "stackId",
        "changeSetId",
        "reviewReceiptSha256",
        "signedTransitionReceiptSha256",
        "executionAttempted",
        "executed",
    }
    allowed_keys = (
        base_keys
        if journal.get("phase") != "not-executed"
        else base_keys | {"resultSha256"}
    )
    if (
        set(journal) != allowed_keys
        or journal.get("schemaVersion") != JOURNAL_SCHEMA
        or journal.get("phase")
        not in {"exact-approval-verified", "lease-primed", "not-executed"}
        or journal.get("transition") != args.transition
        or journal.get("stackId") != args.stack_id
        or journal.get("changeSetId") != args.change_set_id
        or journal.get("reviewReceiptSha256") != args.review_receipt_sha256
        or journal.get("signedTransitionReceiptSha256")
        != receipt.get("receiptSha256")
        or journal.get("executionAttempted") is not False
        or journal.get("executed") is not False
        or reconciliation.get("executionAccepted") is not False
        or reconciliation.get("changeSetExecutionStatus") != "AVAILABLE"
        or reconciliation.get("stackStatus") not in COMPLETE_PRIOR
        or (
            journal.get("phase") == "not-executed"
            and not SHA256.fullmatch(str(journal.get("resultSha256", "")))
        )
    ):
        fail("unattempted activation journal cannot be closed safely")


def stack_status(cli: AwsCli, stack_id: str) -> tuple[str, dict[str, str], dict[str, str]]:
    response = cli.run(
        ["cloudformation", "describe-stacks", "--stack-name", stack_id],
        label="Sonar stack status",
    )
    stacks = response.get("Stacks")
    if not isinstance(stacks, list) or len(stacks) != 1:
        fail("Sonar stack status is incomplete")
    stack = stacks[0]
    return (
        stack.get("StackStatus", ""),
        normalized_parameters(stack.get("Parameters"), label="live stack"),
        normalized_named(
            stack.get("Outputs"),
            "OutputKey",
            "OutputValue",
            label="live stack outputs",
        ),
    )


def finalize_or_monitor(
    args: argparse.Namespace,
    cli: AwsCli,
    journal: dict[str, Any],
    current_parameters: dict[str, str],
    outputs: dict[str, str],
) -> dict[str, Any]:
    deadline = time.monotonic() + args.wait_timeout_seconds
    probes: dict[str, Any] | None = journal.get("probes")
    alarm_arn = outputs["RolesAnywhereActivationRollbackAlarmArn"]
    while time.monotonic() < deadline:
        if args.transition == "roles-anywhere":
            heartbeat(cli, args.stack_name)
        status, live_parameters, live_outputs = stack_status(cli, args.stack_id)
        outputs = live_outputs or outputs
        if status in ACTIVE_ROLLBACK or status == "UPDATE_ROLLBACK_COMPLETE":
            if status != "UPDATE_ROLLBACK_COMPLETE":
                time.sleep(5)
                continue
            validate_identity_plane(
                cli,
                parameters=live_parameters,
                outputs=outputs,
                enabled=args.transition == "lifecycle",
                openssl_bin=args.openssl_bin,
            )
            if args.transition == "lifecycle":
                lifecycle_state(
                    cli,
                    outputs["BucketName"],
                    outputs["SonarPrefix"],
                    enabled=False,
                )
            result = {
                "schemaVersion": RESULT_SCHEMA,
                "status": "rolled-back",
                "transition": args.transition,
                "observedAt": timestamp(),
                "stackId": args.stack_id,
                "changeSetId": args.change_set_id,
                "reviewReceiptSha256": args.review_receipt_sha256,
                "postEnableEvidencePassed": False,
                "servicesRemainBlocked": True,
            }
            result = persist_or_validate_result(args, result)
            update_journal(
                args,
                journal,
                "rolled-back",
                resultSha256=sha256_file(args.evidence_out),
            )
            return result
        if status not in ACTIVE_UPDATE | {"UPDATE_COMPLETE"}:
            fail(f"Sonar transition entered unsupported stack status {status}")
        if args.transition == "roles-anywhere":
            if describe_alarm(cli, alarm_arn, args.stack_name) == "ALARM":
                fail("activation rollback alarm is ALARM; lease remains stopped")
            try:
                heartbeat(cli, args.stack_name)
                revoked_serials = validate_identity_plane(
                    cli,
                    parameters=live_parameters,
                    outputs=outputs,
                    enabled=True,
                    openssl_bin=args.openssl_bin,
                    lease_stack_name=args.stack_name,
                )
            except SystemExit:
                if status == "UPDATE_COMPLETE":
                    raise
                time.sleep(5)
                continue
            if probes is None:
                heartbeat(cli, args.stack_name)
                probes = run_activation_probes(
                    args,
                    cli,
                    outputs,
                    revoked_serials,
                )
                journal = update_journal(
                    args,
                    journal,
                    "post-enable-probes-passed",
                    probes=probes,
                )
            heartbeat(cli, args.stack_name)
            if describe_alarm(cli, alarm_arn, args.stack_name) != "OK":
                fail("activation lease alarm is not OK after post-enable probes")
        else:
            lifecycle_state(
                cli,
                outputs["BucketName"],
                outputs["SonarPrefix"],
                enabled=True,
            )
        if status != "UPDATE_COMPLETE":
            time.sleep(5)
            continue
        result = {
            "schemaVersion": RESULT_SCHEMA,
            "status": "passed",
            "transition": args.transition,
            "observedAt": timestamp(),
            "stackId": args.stack_id,
            "changeSetId": args.change_set_id,
            "reviewReceiptSha256": args.review_receipt_sha256,
            "exactTrustAnchorAndCrlVerified": args.transition == "roles-anywhere",
            "exactProfilesAndRolesVerified": args.transition == "roles-anywhere",
            "postEnableProbes": probes,
            "lifecycleVerified": args.transition == "lifecycle",
            "postEnableEvidencePassed": True,
            "servicesRemainBlockedUntilLiveStateReceipt": True,
            "rawAwsResponsesPersisted": False,
        }
        result = persist_or_validate_result(args, result)
        update_journal(
            args,
            journal,
            "passed",
            resultSha256=sha256_file(args.evidence_out),
        )
        return result
    fail("Sonar transition monitoring exceeded its bounded deadline")


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
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--change-set-id", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--expected-template-sha256", required=True)
    parser.add_argument("--aws-bin", required=True, type=Path)
    parser.add_argument("--aws-config", required=True, type=Path)
    parser.add_argument("--aws-profile", required=True)
    parser.add_argument("--node-bin", required=True, type=Path)
    parser.add_argument("--python-bin", required=True, type=Path)
    parser.add_argument("--openssl-bin", required=True, type=Path)
    parser.add_argument("--receipt-helper", required=True, type=Path)
    parser.add_argument("--base-receipt", required=True, type=Path)
    parser.add_argument("--transition-receipt", required=True, type=Path)
    parser.add_argument("--public-key", required=True, type=Path)
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--backup-success-receipt", type=Path)
    parser.add_argument("--review-receipt", required=True, type=Path)
    parser.add_argument("--review-receipt-sha256", default="")
    parser.add_argument("--journal", type=Path)
    parser.add_argument("--evidence-out", type=Path)
    parser.add_argument("--probe-aws-config", type=Path)
    parser.add_argument("--backup-probe-profile", default="")
    parser.add_argument("--revoked-probe-profile", default="")
    parser.add_argument("--credential-boundary-helper", type=Path)
    parser.add_argument("--aws-signing-helper", type=Path)
    parser.add_argument("--aws-signing-helper-sha256", default="")
    parser.add_argument("--expected-owner-uid", type=int, default=0)
    parser.add_argument("--trust-boundary", type=Path, default=Path("/"))
    parser.add_argument("--command-timeout-seconds", type=int, default=25)
    parser.add_argument("--wait-timeout-seconds", type=int, default=3600)
    parser.add_argument("--execute-reviewed-change-set", action="store_true")
    args = parser.parse_args()

    stack = STACK_ARN.fullmatch(args.stack_id)
    change_set = CHANGE_SET_ARN.fullmatch(args.change_set_id)
    if stack is None or change_set is None:
        fail("stack and change-set IDs must be exact full CloudFormation ARNs")
    args.partition, args.account = stack.group(1), stack.group(3)
    if (
        stack.group(2) != args.region
        or stack.group(4) != args.stack_name
        or change_set.group(1) != args.partition
        or change_set.group(2) != args.region
        or change_set.group(3) != args.account
        or not REGION.fullmatch(args.region)
        or not PROFILE.fullmatch(args.aws_profile)
        or not SHA256.fullmatch(args.expected_template_sha256)
        or not 5 <= args.command_timeout_seconds <= 25
        or not 60 <= args.wait_timeout_seconds <= 7200
    ):
        fail("stack, region, profile, template, or timeout input is invalid")
    if args.expected_owner_uid < 0 or not args.trust_boundary.is_absolute():
        fail("trusted owner or boundary is invalid")
    governed_files = [
        (args.aws_bin, "AWS CLI", False, True),
        (args.aws_config, "owner AWS config", True, False),
        (args.node_bin, "Node.js runtime", False, True),
        (args.python_bin, "Python runtime", False, True),
        (args.openssl_bin, "OpenSSL", False, True),
        (args.receipt_helper, "receipt helper", False, True),
        (args.base_receipt, "base receipt", True, False),
        (args.transition_receipt, "transition receipt", True, False),
        (args.public_key, "owner public key", False, False),
    ]
    if args.transition == "lifecycle":
        if args.backup_success_receipt is None:
            fail("lifecycle transition requires the exact backup-success receipt")
        governed_files.append(
            (args.backup_success_receipt, "backup-success receipt", True, False),
        )
    else:
        required_probe_values = (
            args.probe_aws_config,
            args.credential_boundary_helper,
            args.aws_signing_helper,
        )
        if (
            any(value is None for value in required_probe_values)
            or not PROFILE.fullmatch(args.backup_probe_profile)
            or not PROFILE.fullmatch(args.revoked_probe_profile)
            or args.backup_probe_profile == args.revoked_probe_profile
            or not SHA256.fullmatch(args.aws_signing_helper_sha256)
        ):
            fail("Roles Anywhere transition requires exact positive and revoked probes")
        governed_files.extend(
            [
                (args.probe_aws_config, "probe AWS config", True, False),
                (
                    args.credential_boundary_helper,
                    "credential boundary helper",
                    False,
                    False,
                ),
                (args.aws_signing_helper, "AWS signing helper", False, True),
            ],
        )
    for path, label, private, executable in governed_files:
        trusted_file(
            path,
            label=label,
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
            private=private,
            executable=executable,
        )
    if (
        args.transition == "roles-anywhere"
        and sha256_file(args.aws_signing_helper)
        != args.aws_signing_helper_sha256
    ):
        fail("AWS signing helper differs from its reviewed SHA-256")
    sanitize_owner_config(
        args.aws_config,
        args.aws_profile,
        region=args.region,
        account=args.account,
    )
    cli = AwsCli(
        binary=args.aws_bin,
        config=args.aws_config,
        profile=args.aws_profile,
        region=args.region,
        timeout_seconds=args.command_timeout_seconds,
    )
    recovering = args.operation == "recover-or-finalize"
    receipt = verify_signed_transition(args, allow_expired=recovering)
    binding, current_parameters, outputs, reconciliation = inspect_binding(
        args,
        cli,
        receipt,
        allow_executed=recovering,
    )

    if args.operation == "inspect":
        if (
            args.execute_reviewed_change_set
            or args.review_receipt_sha256
            or args.journal is not None
            or args.evidence_out is not None
        ):
            fail("inspect accepts only a new review-receipt output")
        prepare_new_output(
            args.review_receipt,
            label="review receipt",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        review = {**binding, "inspectedAt": timestamp()}
        atomic_write(args.review_receipt, review, replace=False)
        print(json.dumps({
            "ok": True,
            "operation": "inspect",
            "schemaVersion": REVIEW_SCHEMA,
            "reviewReceiptSha256": sha256_file(args.review_receipt),
        }, separators=(",", ":"), sort_keys=True))
        return

    if (
        not args.execute_reviewed_change_set
        or not SHA256.fullmatch(args.review_receipt_sha256)
        or args.journal is None
        or args.evidence_out is None
    ):
        fail(
            "execute/recover requires the exact review receipt, journal, evidence "
            "output, digest, and --execute-reviewed-change-set",
        )
    for path, label in (
        (args.review_receipt, "review receipt"),
        *(([(args.journal, "activation journal")]) if recovering else []),
    ):
        trusted_file(
            path,
            label=label,
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
    if sha256_file(args.review_receipt) != args.review_receipt_sha256:
        fail("review receipt differs from its approved SHA-256")
    review = read_json(args.review_receipt, label="review receipt")
    if {
        key: value for key, value in review.items() if key != "inspectedAt"
    } != binding:
        fail("live stack or change set differs from the exact review receipt")
    if recovering:
        journal = read_json(args.journal, label="activation journal")
        if not args.evidence_out.exists():
            prepare_new_output(
                args.evidence_out,
                label="activation evidence",
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )
        else:
            trusted_file(
                args.evidence_out,
                label="activation evidence",
                owner_uid=args.expected_owner_uid,
                boundary=args.trust_boundary,
            )
        if journal.get("executionAttempted") is False:
            validate_unattempted_execution(
                args,
                journal,
                reconciliation,
                receipt,
            )
            result = {
                "schemaVersion": RESULT_SCHEMA,
                "status": "not-executed",
                "transition": args.transition,
                "observedAt": timestamp(),
                "stackId": args.stack_id,
                "changeSetId": args.change_set_id,
                "reviewReceiptSha256": args.review_receipt_sha256,
                "changeSetRemainsAvailable": True,
                "stackRemainsAtReviewedPredecessor": True,
                "servicesRemainBlocked": True,
                "freshOwnerAuthorizationRequired": True,
            }
            result = persist_or_validate_result(args, result)
            journal = update_journal(
                args,
                journal,
                "not-executed",
                resultSha256=sha256_file(args.evidence_out),
            )
            print(json.dumps({
                "ok": False,
                "operation": args.operation,
                "schemaVersion": RESULT_SCHEMA,
                "status": result["status"],
                "evidenceSha256": journal["resultSha256"],
            }, separators=(",", ":"), sort_keys=True))
            return
        journal = reconcile_execution(args, journal, reconciliation, receipt)
    else:
        prepare_new_output(
            args.journal,
            label="activation journal",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        prepare_new_output(
            args.evidence_out,
            label="activation evidence",
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
        )
        if args.transition == "roles-anywhere":
            pre_prime_recheck = verify_signed_transition(
                args,
                allow_expired=False,
            )
            if pre_prime_recheck != receipt:
                fail("signed transition changed before activation lease priming")
            require_mutation_authorization_margin(
                args,
                pre_prime_recheck,
                additional_seconds=(
                    90 + args.command_timeout_seconds * 2 + 5
                ),
                include_final_verification=True,
            )
        journal = {
            "schemaVersion": JOURNAL_SCHEMA,
            "phase": "exact-approval-verified",
            "createdAt": timestamp(),
            "updatedAt": timestamp(),
            "transition": args.transition,
            "stackId": args.stack_id,
            "changeSetId": args.change_set_id,
            "reviewReceiptSha256": args.review_receipt_sha256,
            "signedTransitionReceiptSha256": receipt["receiptSha256"],
            "executionAttempted": False,
            "executed": False,
        }
        write_journal(args, journal, create=True)
        if args.transition == "roles-anywhere":
            prime_alarm(
                args,
                cli,
                receipt,
                outputs["RolesAnywhereActivationRollbackAlarmArn"],
                args.stack_name,
            )
            journal = update_journal(args, journal, "lease-primed")
        journal = execute_exact_change_set(args, cli, journal, receipt)
    result = finalize_or_monitor(
        args,
        cli,
        journal,
        current_parameters,
        outputs,
    )
    print(json.dumps({
        "ok": result["status"] == "passed",
        "operation": args.operation,
        "schemaVersion": RESULT_SCHEMA,
        "status": result["status"],
        "evidenceSha256": sha256_file(args.evidence_out),
    }, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
