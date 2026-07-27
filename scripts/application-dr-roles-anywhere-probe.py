#!/usr/bin/env python3
"""Produce bounded, machine-independent IAM Roles Anywhere revocation evidence."""

from __future__ import annotations

import argparse
import configparser
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
from typing import Any, NoReturn


SCHEMA = "NexusApplicationDrRolesAnywhereProbeV1"
LIVE_CRL_SCHEMA = "nexus.application-dr-crl-live-verification.v1"
ROLE_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):"
    r"role/(?:[A-Za-z0-9+=,.@_-]+/)*([A-Za-z0-9+=,.@_-]{1,64})$",
)
ASSUMED_ROLE_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):sts::([0-9]{12}):"
    r"assumed-role/([A-Za-z0-9+=,.@_-]{1,64})/"
    r"([A-Za-z0-9+=,.@_-]{2,64})$",
)
ROLES_ANYWHERE_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:"
    r"([a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]):([0-9]{12}):"
    r"(trust-anchor|profile)/"
    r"([0-9a-z]{8}-(?:[0-9a-z]{4}-){3}[0-9a-z]{12})$",
)
REGION = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]$")
PROFILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")
BUCKET = re.compile(
    r"^(?![0-9]{1,3}(?:\.[0-9]{1,3}){3}$)(?!xn--)(?!sthree-)"
    r"(?!amzn-s3-demo-)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)"
    r"(?!.*--x-s3$)(?!.*--table-s3$)(?!.*\.\.)"
    r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$",
)
PREFIX = re.compile(
    r"^(?!.*\.\.)(?!.*//)[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$",
)
SHA256 = re.compile(r"^[a-f0-9]{64}$")
FORBIDDEN_AWS_ENV = {
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
}
REQUIRED_PROCESS_FLAGS = {
    "--certificate",
    "--private-key",
    "--trust-anchor-arn",
    "--profile-arn",
    "--role-arn",
    "--session-duration",
}
OPTIONAL_PROCESS_FLAGS = {"--region", "--intermediates"}
IDENTITY_FLAGS = (
    "--trust-anchor-arn",
    "--profile-arn",
    "--role-arn",
    "--session-duration",
    "--region",
    "--intermediates",
)
MAX_COMMAND_OUTPUT_BYTES = 128 * 1024
MAX_LIVE_EVIDENCE_BYTES = 256 * 1024
LIVE_EVIDENCE_MAX_AGE = timedelta(minutes=15)
CLOCK_SKEW = timedelta(minutes=5)


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_descriptor(descriptor: int) -> bytes:
    os.lseek(descriptor, 0, os.SEEK_SET)
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > 128 * 1024 * 1024:
            fail("governed input exceeded its read bound")
        chunks.append(chunk)
    return b"".join(chunks)


def validate_parent_chain(
    path: Path,
    *,
    label: str,
    owner_uid: int,
    boundary: Path,
) -> None:
    try:
        canonical_boundary = boundary.resolve(strict=True)
    except OSError as error:
        fail(f"trusted boundary is unavailable: {error}")
    try:
        path.relative_to(canonical_boundary)
    except ValueError:
        fail(f"{label} is outside the trusted boundary")
    current = path.parent
    while True:
        try:
            metadata = current.lstat()
        except OSError as error:
            fail(f"{label} parent path is unavailable: {error}")
        if (
            current.resolve(strict=True) != current
            or stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != owner_uid
            or stat.S_IMODE(metadata.st_mode) & 0o022
        ):
            fail(f"{label} parent path is outside the trusted ownership boundary")
        if current == canonical_boundary:
            return
        if current == current.parent:
            fail(f"{label} did not reach the trusted boundary")
        current = current.parent


def canonical_file(
    path: Path,
    *,
    label: str,
    owner_uid: int,
    boundary: Path,
    executable: bool = False,
    allowed_modes: set[int] | None = None,
    allow_trusted_symlink: bool = False,
) -> Path:
    if not path.is_absolute() or path == Path("/"):
        fail(f"{label} must be an absolute non-root path")
    try:
        link_metadata = path.lstat()
        canonical = path.resolve(strict=True)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    validate_parent_chain(
        path,
        label=label,
        owner_uid=owner_uid,
        boundary=boundary,
    )
    if stat.S_ISLNK(link_metadata.st_mode):
        if not allow_trusted_symlink:
            fail(f"{label} must be canonical and must not traverse symlinks")
        if link_metadata.st_uid != owner_uid:
            fail(f"{label} symlink has an untrusted owner")
    elif canonical != path:
        fail(f"{label} must be canonical and must not traverse symlinks")
    try:
        metadata = canonical.lstat()
    except OSError as error:
        fail(f"{label} target is unavailable: {error}")
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        fail(f"{label} must resolve to a single-link regular file")
    if metadata.st_uid != owner_uid:
        fail(f"{label} has an untrusted owner")
    mode = stat.S_IMODE(metadata.st_mode)
    if allowed_modes is not None and mode not in allowed_modes:
        fail(f"{label} mode is outside the trusted allowlist")
    if mode & 0o022:
        fail(f"{label} must not be group/world writable")
    if executable and mode & 0o111 == 0:
        fail(f"{label} must be executable")
    validate_parent_chain(
        canonical,
        label=label,
        owner_uid=owner_uid,
        boundary=boundary,
    )
    return canonical


def watch_file(path: Path, *, hash_content: bool) -> dict[str, Any]:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
        metadata = os.fstat(descriptor)
    except OSError as error:
        fail(f"could not retain governed input {path}: {error}")
    if not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor)
        fail(f"governed input is no longer a regular file: {path}")
    return {
        "path": path,
        "descriptor": descriptor,
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "size": metadata.st_size,
        "mtimeNs": metadata.st_mtime_ns,
        "ctimeNs": metadata.st_ctime_ns,
        "sha256": sha256_bytes(read_descriptor(descriptor)) if hash_content else None,
    }


def watched_bytes(watch: dict[str, Any], max_bytes: int, label: str) -> bytes:
    body = read_descriptor(watch["descriptor"])
    if not body or len(body) > max_bytes:
        fail(f"{label} size is outside its bound")
    return body


def assert_watches_unchanged(watches: list[dict[str, Any]]) -> None:
    for watch in watches:
        try:
            path_metadata = watch["path"].lstat()
            held_metadata = os.fstat(watch["descriptor"])
        except OSError as error:
            fail(f"governed input became unavailable: {error}")
        expected = (
            watch["dev"],
            watch["ino"],
            watch["size"],
            watch["mtimeNs"],
            watch["ctimeNs"],
        )
        path_actual = (
            path_metadata.st_dev,
            path_metadata.st_ino,
            path_metadata.st_size,
            path_metadata.st_mtime_ns,
            path_metadata.st_ctime_ns,
        )
        held_actual = (
            held_metadata.st_dev,
            held_metadata.st_ino,
            held_metadata.st_size,
            held_metadata.st_mtime_ns,
            held_metadata.st_ctime_ns,
        )
        if path_actual != expected or held_actual != expected:
            fail(f"governed input changed during the probe: {watch['path']}")
        if watch["sha256"] is not None:
            if sha256_bytes(read_descriptor(watch["descriptor"])) != watch["sha256"]:
                fail(f"governed input bytes changed during the probe: {watch['path']}")


def close_watches(watches: list[dict[str, Any]]) -> None:
    for watch in watches:
        try:
            os.close(watch["descriptor"])
        except OSError:
            pass


def parse_process(config: Path, profile: str, helper: Path) -> dict[str, str]:
    parser = configparser.RawConfigParser(interpolation=None)
    try:
        with config.open(encoding="utf-8") as source:
            parser.read_file(source)
    except (OSError, configparser.Error) as error:
        fail(f"AWS config is unreadable: {error}")
    section = f"profile {profile}"
    if section not in parser:
        fail(f"AWS config is missing {section}")
    selected = {key: value.strip() for key, value in parser[section].items()}
    if set(selected) != {"region", "credential_process"}:
        fail("AWS profile may contain only region and credential_process")
    try:
        tokens = shlex.split(selected["credential_process"], posix=True)
    except ValueError as error:
        fail(f"credential_process is invalid: {error}")
    if len(tokens) < 2 or tokens[:2] != [str(helper), "credential-process"]:
        fail("credential_process does not use the exact reviewed helper")
    values: dict[str, str] = {}
    allowed = REQUIRED_PROCESS_FLAGS | OPTIONAL_PROCESS_FLAGS
    index = 2
    while index < len(tokens):
        flag = tokens[index]
        if (
            flag not in allowed
            or index + 1 >= len(tokens)
            or tokens[index + 1].startswith("--")
        ):
            fail("credential_process option is malformed or unapproved")
        if flag in values:
            fail("credential_process repeats an option")
        values[flag] = tokens[index + 1]
        index += 2
    missing = sorted(REQUIRED_PROCESS_FLAGS - set(values))
    if missing:
        fail("credential_process is missing required options: " + ",".join(missing))
    if selected["region"] != values.get("--region", selected["region"]):
        fail("credential_process and profile regions differ")
    for flag in ("--certificate", "--private-key"):
        candidate = Path(values[flag])
        if (
            not candidate.is_absolute()
            or candidate == Path("/")
            or str(candidate) != str(candidate.resolve(strict=False))
        ):
            fail(f"{flag} must use a canonical absolute path")
    return values


def clean_aws_environment(config: Path, profile: str, region: str) -> dict[str, str]:
    return {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/nonexistent",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "AWS_CONFIG_FILE": str(config),
        "AWS_PROFILE": profile,
        "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
        "AWS_EC2_METADATA_DISABLED": "true",
        "AWS_REGION": region,
        "AWS_DEFAULT_REGION": region,
        "AWS_PAGER": "",
        "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true",
    }


def clean_local_environment() -> dict[str, str]:
    return {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/nonexistent",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }


def run_bounded(
    command: list[str],
    *,
    environment: dict[str, str],
    timeout_seconds: int = 30,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            command,
            check=False,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"bounded probe command failed to execute: {error}")
    if (
        len(result.stdout) > MAX_COMMAND_OUTPUT_BYTES
        or len(result.stderr) > MAX_COMMAND_OUTPUT_BYTES
    ):
        fail("bounded probe command output exceeded its limit")
    return result


def parse_json_output(result: subprocess.CompletedProcess[bytes], label: str) -> Any:
    if result.returncode != 0:
        fail(f"{label} failed")
    try:
        return json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} did not return bounded JSON: {error}")


def validate_boundary(
    *,
    python_bin: Path,
    boundary_helper: Path,
    config: Path,
    profile: str,
    region: str,
    signing_helper: Path,
    signing_helper_sha256: str,
    expected_role_arn: str,
    owner_uid: int,
    trust_boundary: Path,
) -> str:
    result = run_bounded(
        [
            str(python_bin),
            str(boundary_helper),
            "--config",
            str(config),
            "--profile",
            profile,
            "--region",
            region,
            "--helper",
            str(signing_helper),
            "--helper-sha256",
            signing_helper_sha256,
            "--expected-role-arn",
            expected_role_arn,
            "--expected-owner-uid",
            str(owner_uid),
            "--trust-boundary",
            str(trust_boundary),
        ],
        environment=clean_aws_environment(config, profile, region),
    )
    payload = parse_json_output(result, f"credential boundary for {profile}")
    if (
        not isinstance(payload, dict)
        or payload.get("schemaVersion") != "NexusAwsCredentialProcessBoundaryV1"
        or payload.get("status") != "passed"
        or payload.get("credentialSource")
        != "iam-roles-anywhere-credential-process"
        or payload.get("helperSha256") != signing_helper_sha256
    ):
        fail(f"credential boundary for {profile} returned invalid evidence")
    return sha256_bytes(result.stdout)


def parse_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(f"{label} is not a canonical UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        fail(f"{label} is not a valid timestamp")
    if parsed.tzinfo is None:
        fail(f"{label} has no timezone")
    return parsed.astimezone(timezone.utc)


def validate_live_crl_evidence(
    body: bytes,
    *,
    region: str,
    trust_anchor_arn: str,
    profile_arn: str,
    ca_sha256: str,
    crl_sha256: str,
    now: datetime,
) -> dict[str, Any]:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"live CRL evidence is invalid JSON: {error}")
    if not isinstance(payload, dict) or payload.get("schema") != LIVE_CRL_SCHEMA:
        fail("live CRL evidence schema is invalid")
    exact = {
        "region": region,
        "trustAnchorArn": trust_anchor_arn,
        "trustAnchorEnabled": True,
        "backupProfileArn": profile_arn,
        "backupProfileEnabled": True,
        "caCertificateSha256": ca_sha256,
        "crlSha256": crl_sha256,
        "crlEnabled": True,
        "exactBytesVerified": True,
        "digestTagVerified": True,
    }
    for key, value in exact.items():
        if payload.get(key) != value:
            fail(f"live CRL evidence differs at {key}")
    verified_at = parse_time(payload.get("verifiedAt"), "live CRL verifiedAt")
    if verified_at > now + CLOCK_SKEW or now - verified_at > LIVE_EVIDENCE_MAX_AGE:
        fail("live CRL evidence is stale or future-dated")
    last_update = parse_time(payload.get("lastUpdate"), "live CRL lastUpdate")
    next_update = parse_time(payload.get("nextUpdate"), "live CRL nextUpdate")
    if last_update > now + CLOCK_SKEW or next_update <= now:
        fail("live CRL validity interval does not cover the probe")
    return payload


def run_openssl_success(
    openssl_bin: Path,
    arguments: list[str],
    label: str,
) -> subprocess.CompletedProcess[bytes]:
    result = run_bounded(
        [str(openssl_bin), *arguments],
        environment=clean_local_environment(),
    )
    if result.returncode != 0:
        fail(f"{label} failed")
    return result


def public_key(
    openssl_bin: Path,
    *,
    kind: str,
    path: Path,
    label: str,
) -> bytes:
    if kind == "certificate":
        arguments = ["x509", "-in", str(path), "-pubkey", "-noout"]
    else:
        arguments = ["pkey", "-in", str(path), "-pubout"]
    result = run_openssl_success(openssl_bin, arguments, label)
    if (
        not result.stdout.startswith(b"-----BEGIN PUBLIC KEY-----")
        or b"-----END PUBLIC KEY-----" not in result.stdout
        or b"PRIVATE KEY" in result.stdout
    ):
        fail(f"{label} returned invalid public-key material")
    return result.stdout


def validate_local_revocation(
    *,
    openssl_bin: Path,
    ca_certificate: Path,
    crl: Path,
    positive_certificate: Path,
    positive_key: Path,
    revoked_certificate: Path,
    revoked_key: Path,
) -> tuple[str, str]:
    run_openssl_success(
        openssl_bin,
        ["crl", "-in", str(crl), "-CAfile", str(ca_certificate), "-verify", "-noout"],
        "CRL signature verification",
    )
    run_openssl_success(
        openssl_bin,
        ["crl", "-in", str(crl), "-checkend", "0", "-noout"],
        "CRL validity verification",
    )
    for certificate, label in (
        (positive_certificate, "positive certificate chain verification"),
        (revoked_certificate, "revoked certificate base chain verification"),
    ):
        run_openssl_success(
            openssl_bin,
            ["verify", "-CAfile", str(ca_certificate), str(certificate)],
            label,
        )
    run_openssl_success(
        openssl_bin,
        [
            "verify",
            "-CAfile",
            str(ca_certificate),
            "-crl_check",
            "-CRLfile",
            str(crl),
            str(positive_certificate),
        ],
        "positive certificate CRL verification",
    )
    revoked_check = run_bounded(
        [
            str(openssl_bin),
            "verify",
            "-CAfile",
            str(ca_certificate),
            "-crl_check",
            "-CRLfile",
            str(crl),
            str(revoked_certificate),
        ],
        environment=clean_local_environment(),
    )
    if revoked_check.returncode == 0:
        fail("reviewed revoked certificate is not revoked by the exact live CRL")
    positive_cert_spki = public_key(
        openssl_bin,
        kind="certificate",
        path=positive_certificate,
        label="positive certificate public key",
    )
    positive_key_spki = public_key(
        openssl_bin,
        kind="private-key",
        path=positive_key,
        label="positive private-key public key",
    )
    revoked_cert_spki = public_key(
        openssl_bin,
        kind="certificate",
        path=revoked_certificate,
        label="revoked certificate public key",
    )
    revoked_key_spki = public_key(
        openssl_bin,
        kind="private-key",
        path=revoked_key,
        label="revoked private-key public key",
    )
    if positive_cert_spki != positive_key_spki:
        fail("positive certificate and private key do not share a public key")
    if revoked_cert_spki != revoked_key_spki:
        fail("revoked certificate and private key do not share a public key")
    if positive_cert_spki == revoked_cert_spki:
        fail("positive and revoked identities must use distinct public keys")
    return sha256_bytes(positive_cert_spki), sha256_bytes(revoked_cert_spki)


def validate_identity(
    result: subprocess.CompletedProcess[bytes],
    *,
    role_match: re.Match[str],
    label: str,
) -> dict[str, Any]:
    identity = parse_json_output(result, label)
    if not isinstance(identity, dict):
        fail(f"{label} shape is invalid")
    assumed = ASSUMED_ROLE_ARN.fullmatch(str(identity.get("Arn", "")))
    if (
        assumed is None
        or assumed.group(1) != role_match.group(1)
        or assumed.group(2) != role_match.group(2)
        or assumed.group(3) != role_match.group(3)
        or identity.get("Account") != role_match.group(2)
    ):
        fail(f"{label} differs from the exact expected role")
    return identity


def write_evidence(
    path: Path,
    payload: dict[str, Any],
    owner_uid: int,
    boundary: Path,
) -> None:
    if not path.is_absolute() or path == Path("/"):
        fail("evidence output must be an absolute non-root path")
    parent = path.parent
    try:
        metadata = parent.lstat()
        canonical_parent = parent.resolve(strict=True)
    except OSError as error:
        fail(f"evidence output parent is unavailable: {error}")
    if (
        canonical_parent != parent
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != owner_uid
        or stat.S_IMODE(metadata.st_mode) & 0o077
    ):
        fail("evidence output parent must be owner-private and canonical")
    validate_parent_chain(
        path,
        label="evidence output",
        owner_uid=owner_uid,
        boundary=boundary,
    )
    if path.exists() or path.is_symlink():
        fail("evidence output already exists")
    body = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = parent / (
        f".{path.name}.tmp.{os.getpid()}.{secrets.token_hex(8)}"
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(temporary, flags, 0o600)
        try:
            offset = 0
            while offset < len(body):
                written = os.write(descriptor, body[offset:])
                if written <= 0:
                    fail("could not write complete probe evidence")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.link(temporary, path, follow_symlinks=False)
        directory_flags = os.O_RDONLY
        if hasattr(os, "O_DIRECTORY"):
            directory_flags |= os.O_DIRECTORY
        directory = os.open(parent, directory_flags)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as error:
        fail(f"could not create evidence output: {error}")
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--positive-config", required=True, type=Path)
    parser.add_argument("--positive-profile", required=True)
    parser.add_argument("--revoked-config", required=True, type=Path)
    parser.add_argument("--revoked-profile", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--expected-role-arn", required=True)
    parser.add_argument("--expected-trust-anchor-arn", required=True)
    parser.add_argument("--expected-profile-arn", required=True)
    parser.add_argument("--expected-bucket", required=True)
    parser.add_argument("--expected-prefix", required=True)
    parser.add_argument("--expected-positive-certificate-sha256", required=True)
    parser.add_argument("--expected-revoked-certificate-sha256", required=True)
    parser.add_argument("--ca-certificate", required=True, type=Path)
    parser.add_argument("--crl", required=True, type=Path)
    parser.add_argument("--live-crl-evidence", required=True, type=Path)
    parser.add_argument("--aws-bin", required=True, type=Path)
    parser.add_argument("--openssl-bin", required=True, type=Path)
    parser.add_argument("--python-bin", required=True, type=Path)
    parser.add_argument("--boundary-helper", required=True, type=Path)
    parser.add_argument("--signing-helper", required=True, type=Path)
    parser.add_argument("--signing-helper-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-owner-uid", type=int, default=0)
    parser.add_argument("--trust-boundary", type=Path, default=Path("/"))
    parser.add_argument("--test-mode", action="store_true")
    args = parser.parse_args()

    if os.geteuid() == 0 and args.test_mode:
        fail("test mode is forbidden for a privileged invocation")
    if not args.test_mode and os.geteuid() != 0:
        fail("production Roles Anywhere probe must run as root")
    if args.expected_owner_uid != os.geteuid():
        fail("expected owner uid must equal the invoking uid")
    forbidden_environment = sorted(
        key for key in FORBIDDEN_AWS_ENV if key in os.environ
    )
    if forbidden_environment:
        fail(
            "alternate or long-lived AWS credential environment is forbidden: "
            + ",".join(forbidden_environment),
        )
    if not args.trust_boundary.is_absolute():
        fail("trusted boundary must be absolute")
    if not REGION.fullmatch(args.region):
        fail("AWS region is invalid")
    if not PROFILE.fullmatch(args.positive_profile) or not PROFILE.fullmatch(
        args.revoked_profile,
    ):
        fail("AWS profile is invalid")
    if args.positive_profile == args.revoked_profile:
        fail("positive and revoked profiles must be distinct")
    role_match = ROLE_ARN.fullmatch(args.expected_role_arn)
    if role_match is None:
        fail("expected role ARN is invalid")
    trust_anchor_match = ROLES_ANYWHERE_ARN.fullmatch(args.expected_trust_anchor_arn)
    profile_match = ROLES_ANYWHERE_ARN.fullmatch(args.expected_profile_arn)
    if (
        trust_anchor_match is None
        or trust_anchor_match.group(4) != "trust-anchor"
        or profile_match is None
        or profile_match.group(4) != "profile"
        or trust_anchor_match.group(1, 2, 3) != profile_match.group(1, 2, 3)
        or trust_anchor_match.group(1) != role_match.group(1)
        or trust_anchor_match.group(2) != args.region
        or trust_anchor_match.group(3) != role_match.group(2)
    ):
        fail("expected Roles Anywhere ARNs are invalid or inconsistent")
    if not BUCKET.fullmatch(args.expected_bucket):
        fail("expected bucket is invalid")
    if not PREFIX.fullmatch(args.expected_prefix):
        fail("expected prefix is invalid")
    for value, label in (
        (args.signing_helper_sha256, "signing helper"),
        (args.expected_positive_certificate_sha256, "positive certificate"),
        (args.expected_revoked_certificate_sha256, "revoked certificate"),
    ):
        if not SHA256.fullmatch(value):
            fail(f"{label} SHA-256 is invalid")
    if (
        args.expected_positive_certificate_sha256
        == args.expected_revoked_certificate_sha256
    ):
        fail("positive and revoked certificate digests must be distinct")

    resolved: dict[str, Path] = {}
    file_specs = (
        ("positive_config", args.positive_config, "positive AWS config", False, {0o600}, False),
        ("revoked_config", args.revoked_config, "revoked AWS config", False, {0o600}, False),
        ("ca_certificate", args.ca_certificate, "CA certificate", False, {0o600, 0o644}, False),
        ("crl", args.crl, "CRL", False, {0o600, 0o644}, False),
        ("live_crl_evidence", args.live_crl_evidence, "live CRL evidence", False, {0o600}, False),
        ("aws_bin", args.aws_bin, "AWS CLI", True, None, True),
        ("openssl_bin", args.openssl_bin, "OpenSSL", True, None, True),
        ("python_bin", args.python_bin, "Python runtime", True, None, True),
        ("boundary_helper", args.boundary_helper, "credential boundary helper", False, {0o644}, False),
        ("signing_helper", args.signing_helper, "Roles Anywhere signing helper", True, {0o500, 0o700, 0o755}, False),
    )
    for key, path, label, executable, modes, allow_symlink in file_specs:
        resolved[key] = canonical_file(
            path,
            label=label,
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
            executable=executable,
            allowed_modes=modes,
            allow_trusted_symlink=allow_symlink,
        )

    positive_process = parse_process(
        resolved["positive_config"],
        args.positive_profile,
        resolved["signing_helper"],
    )
    revoked_process = parse_process(
        resolved["revoked_config"],
        args.revoked_profile,
        resolved["signing_helper"],
    )
    for flag in IDENTITY_FLAGS:
        if positive_process.get(flag) != revoked_process.get(flag):
            fail(f"revoked profile changes immutable identity option {flag}")
    exact_identity = {
        "--trust-anchor-arn": args.expected_trust_anchor_arn,
        "--profile-arn": args.expected_profile_arn,
        "--role-arn": args.expected_role_arn,
        "--session-duration": "900",
    }
    for flag, expected in exact_identity.items():
        if positive_process.get(flag) != expected:
            fail(f"credential profiles differ from exact expected {flag}")
    if positive_process.get("--region", args.region) != args.region:
        fail("credential profile region differs from the exact expected region")
    for flag in ("--certificate", "--private-key"):
        if positive_process[flag] == revoked_process[flag]:
            fail(f"revoked profile must use a distinct {flag}")

    identity_paths: dict[str, Path] = {}
    for key, raw_path, label, modes in (
        ("positive_certificate", positive_process["--certificate"], "positive certificate", {0o600, 0o644}),
        ("positive_key", positive_process["--private-key"], "positive private key", {0o600}),
        ("revoked_certificate", revoked_process["--certificate"], "revoked certificate", {0o600, 0o644}),
        ("revoked_key", revoked_process["--private-key"], "revoked private key", {0o600}),
    ):
        identity_paths[key] = canonical_file(
            Path(raw_path),
            label=label,
            owner_uid=args.expected_owner_uid,
            boundary=args.trust_boundary,
            allowed_modes=modes,
        )

    watches: list[dict[str, Any]] = []
    try:
        private_keys = {
            identity_paths["positive_key"],
            identity_paths["revoked_key"],
        }
        for path in [*resolved.values(), *identity_paths.values()]:
            if not any(watch["path"] == path for watch in watches):
                watches.append(watch_file(path, hash_content=path not in private_keys))
        watch_by_path = {watch["path"]: watch for watch in watches}
        signing_helper_sha256 = watch_by_path[resolved["signing_helper"]]["sha256"]
        if signing_helper_sha256 != args.signing_helper_sha256:
            fail("signing helper differs from its reviewed SHA-256")
        positive_certificate_sha256 = watch_by_path[
            identity_paths["positive_certificate"]
        ]["sha256"]
        revoked_certificate_sha256 = watch_by_path[
            identity_paths["revoked_certificate"]
        ]["sha256"]
        if positive_certificate_sha256 != args.expected_positive_certificate_sha256:
            fail("positive certificate differs from its reviewed SHA-256")
        if revoked_certificate_sha256 != args.expected_revoked_certificate_sha256:
            fail("revoked certificate differs from its reviewed SHA-256")

        now = datetime.now(timezone.utc)
        ca_sha256 = watch_by_path[resolved["ca_certificate"]]["sha256"]
        crl_sha256 = watch_by_path[resolved["crl"]]["sha256"]
        live_crl_body = watched_bytes(
            watch_by_path[resolved["live_crl_evidence"]],
            MAX_LIVE_EVIDENCE_BYTES,
            "live CRL evidence",
        )
        validate_live_crl_evidence(
            live_crl_body,
            region=args.region,
            trust_anchor_arn=args.expected_trust_anchor_arn,
            profile_arn=args.expected_profile_arn,
            ca_sha256=ca_sha256,
            crl_sha256=crl_sha256,
            now=now,
        )
        positive_spki_sha256, revoked_spki_sha256 = validate_local_revocation(
            openssl_bin=resolved["openssl_bin"],
            ca_certificate=resolved["ca_certificate"],
            crl=resolved["crl"],
            positive_certificate=identity_paths["positive_certificate"],
            positive_key=identity_paths["positive_key"],
            revoked_certificate=identity_paths["revoked_certificate"],
            revoked_key=identity_paths["revoked_key"],
        )

        positive_boundary_sha = validate_boundary(
            python_bin=resolved["python_bin"],
            boundary_helper=resolved["boundary_helper"],
            config=resolved["positive_config"],
            profile=args.positive_profile,
            region=args.region,
            signing_helper=resolved["signing_helper"],
            signing_helper_sha256=args.signing_helper_sha256,
            expected_role_arn=args.expected_role_arn,
            owner_uid=args.expected_owner_uid,
            trust_boundary=args.trust_boundary,
        )
        revoked_boundary_sha = validate_boundary(
            python_bin=resolved["python_bin"],
            boundary_helper=resolved["boundary_helper"],
            config=resolved["revoked_config"],
            profile=args.revoked_profile,
            region=args.region,
            signing_helper=resolved["signing_helper"],
            signing_helper_sha256=args.signing_helper_sha256,
            expected_role_arn=args.expected_role_arn,
            owner_uid=args.expected_owner_uid,
            trust_boundary=args.trust_boundary,
        )

        identity_command = [
            str(resolved["aws_bin"]),
            "sts",
            "get-caller-identity",
            "--no-cli-pager",
            "--output",
            "json",
        ]
        positive_environment = clean_aws_environment(
            resolved["positive_config"],
            args.positive_profile,
            args.region,
        )
        identity_before_result = run_bounded(
            identity_command,
            environment=positive_environment,
        )
        validate_identity(
            identity_before_result,
            role_match=role_match,
            label="positive STS identity probe before revocation test",
        )
        listing_result = run_bounded(
            [
                str(resolved["aws_bin"]),
                "s3api",
                "list-object-versions",
                "--bucket",
                args.expected_bucket,
                "--prefix",
                f"{args.expected_prefix}/",
                "--max-keys",
                "1",
                "--no-paginate",
                "--no-cli-pager",
                "--output",
                "json",
            ],
            environment=positive_environment,
        )
        listing = parse_json_output(listing_result, "positive S3 prefix probe")
        if not isinstance(listing, dict):
            fail("positive S3 prefix probe shape is invalid")

        revoked_result = run_bounded(
            identity_command,
            environment=clean_aws_environment(
                resolved["revoked_config"],
                args.revoked_profile,
                args.region,
            ),
        )
        if revoked_result.returncode == 0:
            fail("revoked certificate unexpectedly obtained AWS credentials")
        if revoked_result.stdout.strip():
            fail("revoked credential attempt returned unexpected standard output")

        identity_after_result = run_bounded(
            identity_command,
            environment=positive_environment,
        )
        validate_identity(
            identity_after_result,
            role_match=role_match,
            label="positive STS identity probe after revocation test",
        )
        assert_watches_unchanged(watches)

        observed = datetime.now(timezone.utc).replace(microsecond=0)
        evidence = {
            "schemaVersion": SCHEMA,
            "status": "passed",
            "observedAt": observed.isoformat().replace("+00:00", "Z"),
            "region": args.region,
            "identityBinding": {
                "expectedRoleArnSha256": sha256_bytes(args.expected_role_arn.encode()),
                "trustAnchorArnSha256": sha256_bytes(
                    args.expected_trust_anchor_arn.encode(),
                ),
                "profileArnSha256": sha256_bytes(args.expected_profile_arn.encode()),
                "liveCrlEvidenceSha256": sha256_bytes(live_crl_body),
                "caCertificateSha256": ca_sha256,
                "crlSha256": crl_sha256,
            },
            "positive": {
                "profile": args.positive_profile,
                "credentialBoundarySha256": positive_boundary_sha,
                "certificateSha256": args.expected_positive_certificate_sha256,
                "publicKeySha256": positive_spki_sha256,
                "callerIdentityBeforeSha256": sha256_bytes(
                    identity_before_result.stdout,
                ),
                "callerIdentityAfterSha256": sha256_bytes(
                    identity_after_result.stdout,
                ),
                "prefixListAuthorized": True,
                "listingSha256": sha256_bytes(listing_result.stdout),
            },
            "revoked": {
                "profile": args.revoked_profile,
                "credentialBoundarySha256": revoked_boundary_sha,
                "certificateSha256": args.expected_revoked_certificate_sha256,
                "publicKeySha256": revoked_spki_sha256,
                "credentialIssuanceDenied": True,
                "localCrlRevocationVerified": True,
                "denialSha256": sha256_bytes(revoked_result.stderr),
            },
            "credentialsPersisted": False,
            "longLivedCredentialsAccepted": False,
        }
        write_evidence(
            args.output,
            evidence,
            args.expected_owner_uid,
            args.trust_boundary,
        )
        print(
            json.dumps(
                {
                    "ok": True,
                    "schemaVersion": SCHEMA,
                    "status": "passed",
                    "evidenceSha256": sha256_bytes(
                        (
                            json.dumps(
                                evidence,
                                sort_keys=True,
                                separators=(",", ":"),
                            )
                            + "\n"
                        ).encode(),
                    ),
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
    finally:
        close_watches(watches)


if __name__ == "__main__":
    main()
