#!/usr/bin/env python3
"""Verify the fail-closed IAM Roles Anywhere credential_process boundary."""

from __future__ import annotations

import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
from typing import NoReturn


RESULT_SCHEMA = "NexusAwsCredentialProcessBoundaryV1"
PROFILE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
REGION_PATTERN = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z]+-\d$")
ROLES_ANYWHERE_ARN_PATTERN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:([a-z0-9-]+):(\d{12}):"
    r"(trust-anchor|profile)/([A-Za-z0-9][A-Za-z0-9._/-]{1,127})$",
)
ROLE_ARN_PATTERN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):"
    r"role/([A-Za-z0-9+=,.@_/-]{1,512})$",
)
FORBIDDEN_ENVIRONMENT_KEYS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_CREDENTIAL_FILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
)
REQUIRED_PROCESS_FLAGS = (
    "--certificate",
    "--private-key",
    "--trust-anchor-arn",
    "--profile-arn",
    "--role-arn",
    "--session-duration",
)
OPTIONAL_PROCESS_FLAGS = (
    "--region",
    "--intermediates",
)


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def trusted_path(
    path: Path,
    *,
    label: str,
    expected_owner_uid: int,
    trust_boundary: Path,
    allowed_modes: set[int],
    executable: bool = False,
) -> None:
    try:
        canonical_path = path.resolve(strict=True)
        canonical_boundary = trust_boundary.resolve(strict=True)
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if canonical_path != path or stat.S_ISLNK(metadata.st_mode):
        fail(f"{label} must be canonical and must not traverse symlinks")
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        fail(f"{label} must be a single-link regular file")
    if metadata.st_uid != expected_owner_uid:
        fail(f"{label} has an untrusted owner")
    mode = stat.S_IMODE(metadata.st_mode)
    if mode not in allowed_modes:
        fail(f"{label} mode is outside the trusted allowlist")
    if executable and mode & 0o111 == 0:
        fail(f"{label} must be executable")
    try:
        path.relative_to(canonical_boundary)
    except ValueError:
        fail(f"{label} is outside its trusted path boundary")

    current = path.parent
    while True:
        try:
            current_metadata = current.lstat()
        except OSError as error:
            fail(f"{label} parent path is unavailable: {error}")
        if stat.S_ISLNK(current_metadata.st_mode) or not stat.S_ISDIR(current_metadata.st_mode):
            fail(f"{label} parent path must be a canonical directory")
        if current.resolve(strict=True) != current:
            fail(f"{label} parent path must not traverse symlinks")
        if current_metadata.st_uid != expected_owner_uid:
            fail(f"{label} parent path has an untrusted owner")
        if stat.S_IMODE(current_metadata.st_mode) & 0o022:
            fail(f"{label} parent path is group/world writable")
        if current == canonical_boundary:
            break
        if current == current.parent:
            fail(f"{label} did not reach its trusted path boundary")
        current = current.parent


def parse_process(command: str, helper: Path) -> dict[str, str]:
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError as error:
        fail(f"credential_process is not valid shell-like syntax: {error}")
    if len(tokens) < 2 or tokens[0] != str(helper) or tokens[1] != "credential-process":
        fail("credential_process must invoke the exact reviewed helper and credential-process")

    allowed = set(REQUIRED_PROCESS_FLAGS) | set(OPTIONAL_PROCESS_FLAGS)
    values: dict[str, str] = {}
    index = 2
    while index < len(tokens):
        flag = tokens[index]
        if flag not in allowed:
            fail(f"credential_process contains an unapproved option: {flag}")
        if flag in values:
            fail(f"credential_process repeats option: {flag}")
        if index + 1 >= len(tokens) or tokens[index + 1].startswith("--"):
            fail(f"credential_process option has no value: {flag}")
        values[flag] = tokens[index + 1]
        index += 2
    missing = [flag for flag in REQUIRED_PROCESS_FLAGS if flag not in values]
    if missing:
        fail(f"credential_process is missing required options: {','.join(missing)}")
    for flag in ("--certificate", "--private-key"):
        value = values[flag]
        if (
            not re.fullmatch(r"/[A-Za-z0-9._/-]+", value)
            or value == "/"
            or "/../" in f"{value}/"
            or "/./" in f"{value}/"
            or "//" in value
        ):
            fail(f"{flag} must use a canonical shell-safe absolute non-root path")
    if "--intermediates" in values and not re.fullmatch(
        r"/[A-Za-z0-9._/-]+",
        values["--intermediates"],
    ):
        fail("--intermediates must use a shell-safe absolute path")
    if values["--session-duration"] != "900":
        fail("--session-duration must equal the approved 900-second profile ceiling")
    return values


def validate_arns(
    values: dict[str, str],
    region: str,
    expected_role_arn: str,
) -> None:
    trust_anchor = ROLES_ANYWHERE_ARN_PATTERN.fullmatch(values["--trust-anchor-arn"])
    profile = ROLES_ANYWHERE_ARN_PATTERN.fullmatch(values["--profile-arn"])
    role = ROLE_ARN_PATTERN.fullmatch(values["--role-arn"])
    if trust_anchor is None or trust_anchor.group(4) != "trust-anchor":
        fail("credential_process trust-anchor ARN is invalid")
    if profile is None or profile.group(4) != "profile":
        fail("credential_process profile ARN is invalid")
    if role is None:
        fail("credential_process role ARN is invalid")
    if values["--role-arn"] != expected_role_arn:
        fail("credential_process role ARN differs from the exact expected role")
    if (
        trust_anchor.group(1) != profile.group(1)
        or trust_anchor.group(1) != role.group(1)
        or trust_anchor.group(2) != region
        or profile.group(2) != region
        or trust_anchor.group(3) != profile.group(3)
        or trust_anchor.group(3) != role.group(2)
    ):
        fail("credential_process ARNs do not share the configured partition, region, and account")
    if "--region" in values and values["--region"] != region:
        fail("credential_process region differs from the configured AWS region")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--helper", required=True, type=Path)
    parser.add_argument("--helper-sha256", required=True)
    parser.add_argument("--expected-role-arn", required=True)
    parser.add_argument("--expected-owner-uid", type=int, default=0)
    parser.add_argument("--trust-boundary", type=Path, default=Path("/"))
    args = parser.parse_args()

    if not PROFILE_PATTERN.fullmatch(args.profile):
        fail("AWS profile name is invalid")
    if not REGION_PATTERN.fullmatch(args.region):
        fail("AWS region is invalid")
    if not SHA256_PATTERN.fullmatch(args.helper_sha256):
        fail("reviewed aws_signing_helper SHA-256 is invalid")
    if ROLE_ARN_PATTERN.fullmatch(args.expected_role_arn) is None:
        fail("exact expected role ARN is invalid")
    if not args.config.is_absolute() or args.config == Path("/"):
        fail("AWS config must use an absolute non-root path")
    if not args.helper.is_absolute() or args.helper == Path("/"):
        fail("aws_signing_helper must use an absolute non-root path")
    if args.expected_owner_uid < 0:
        fail("expected owner uid must be non-negative")
    if not args.trust_boundary.is_absolute():
        fail("trusted path boundary must be absolute")

    trusted_path(
        args.config,
        label="AWS config",
        expected_owner_uid=args.expected_owner_uid,
        trust_boundary=args.trust_boundary,
        allowed_modes={0o600},
    )
    trusted_path(
        args.helper,
        label="aws_signing_helper",
        expected_owner_uid=args.expected_owner_uid,
        trust_boundary=args.trust_boundary,
        allowed_modes={0o500, 0o700, 0o755},
        executable=True,
    )

    present = [key for key in FORBIDDEN_ENVIRONMENT_KEYS if key in os.environ]
    if present:
        fail(
            "alternate or long-lived AWS credential environment is forbidden: "
            + ",".join(present),
        )
    if os.environ.get("AWS_CONFIG_FILE") != str(args.config):
        fail("AWS_CONFIG_FILE must name the exact reviewed config")
    if os.environ.get("AWS_PROFILE") != args.profile:
        fail("AWS_PROFILE must name the exact reviewed profile")
    if os.environ.get("AWS_SHARED_CREDENTIALS_FILE") != "/dev/null":
        fail("AWS_SHARED_CREDENTIALS_FILE must be /dev/null")
    if os.environ.get("AWS_EC2_METADATA_DISABLED", "").lower() != "true":
        fail("AWS_EC2_METADATA_DISABLED must be true")

    try:
        actual_helper_sha256 = file_sha256(args.helper)
    except OSError as error:
        fail(f"aws_signing_helper is unreadable: {error}")
    if actual_helper_sha256 != args.helper_sha256:
        fail("aws_signing_helper differs from its reviewed SHA-256")

    parser_config = configparser.RawConfigParser(interpolation=None)
    try:
        with args.config.open(encoding="utf-8") as source:
            parser_config.read_file(source)
    except (OSError, configparser.Error) as error:
        fail(f"AWS config is unreadable: {error}")
    section = f"profile {args.profile}"
    if section not in parser_config:
        fail("AWS config is missing the exact selected profile")
    if parser_config.defaults():
        fail("AWS config must not define default credential settings")
    selected = {key: value.strip() for key, value in parser_config[section].items()}
    if set(selected) != {"region", "credential_process"}:
        fail("selected AWS profile may contain only region and credential_process")
    if selected["region"] != args.region:
        fail("selected AWS profile region differs from the configured AWS region")

    values = parse_process(selected["credential_process"], args.helper)
    validate_arns(values, args.region, args.expected_role_arn)
    trusted_path(
        Path(values["--certificate"]),
        label="Roles Anywhere certificate",
        expected_owner_uid=args.expected_owner_uid,
        trust_boundary=args.trust_boundary,
        allowed_modes={0o400, 0o444, 0o600, 0o644},
    )
    trusted_path(
        Path(values["--private-key"]),
        label="Roles Anywhere private key",
        expected_owner_uid=args.expected_owner_uid,
        trust_boundary=args.trust_boundary,
        allowed_modes={0o400, 0o600},
    )
    if "--intermediates" in values:
        trusted_path(
            Path(values["--intermediates"]),
            label="Roles Anywhere intermediates",
            expected_owner_uid=args.expected_owner_uid,
            trust_boundary=args.trust_boundary,
            allowed_modes={0o400, 0o444, 0o600, 0o644},
        )
    print(
        json.dumps(
            {
                "schemaVersion": RESULT_SCHEMA,
                "status": "passed",
                "profile": args.profile,
                "region": args.region,
                "helperSha256": actual_helper_sha256,
                "credentialSource": "iam-roles-anywhere-credential-process",
                "longLivedEnvironmentRejected": True,
                "sharedCredentialsDisabled": True,
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
    )


if __name__ == "__main__":
    main()
