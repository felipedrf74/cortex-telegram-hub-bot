#!/usr/bin/env python3
"""Validate owner-retained object-store control evidence for application DR."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any, NoReturn


SCHEMA = "nexus.application-dr-storage-controls.v1"
RESULT_SCHEMA = "NexusApplicationDrStorageControlsVerificationV1"
MAX_EVIDENCE_AGE_SECONDS = 30 * 24 * 60 * 60
MAX_CLOCK_SKEW_SECONDS = 5 * 60
PROVIDER_MODES = {
    "aws-s3": "versioned-s3",
    "cloudflare-r2": "r2-approved-variance",
}
REFERENCE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+-]{5,255}$")
APPROVER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def exact_object(
    value: Any,
    fields: set[str],
    label: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        fail(f"{label} fields do not match the governed schema")
    return value


def canonical_timestamp(raw: Any, label: str) -> int:
    if not isinstance(raw, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z",
        raw,
    ):
        fail(f"{label} must be a canonical whole-second UTC timestamp")
    try:
        parsed = datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc,
        )
    except ValueError as error:
        fail(f"{label} is invalid: {error}")
    return int(parsed.timestamp())


def validate_evidence(
    evidence: Any,
    *,
    provider: str,
    control_mode: str,
    endpoint: str,
    bucket: str,
    prefix: str,
    now_epoch: int,
) -> dict[str, Any]:
    expected_mode = PROVIDER_MODES.get(provider)
    if expected_mode is None:
        fail("object-store provider must be aws-s3 or cloudflare-r2")
    if control_mode != expected_mode:
        fail(f"{provider} requires control mode {expected_mode}")

    common_fields = {
        "schema",
        "provider",
        "controlMode",
        "endpoint",
        "bucket",
        "prefix",
        "verifiedAt",
        "verificationReference",
        "versioning",
        "releasePrefixLock",
    }
    expected_fields = (
        common_fields | {"varianceApproval"}
        if provider == "cloudflare-r2"
        else common_fields
    )
    root = exact_object(evidence, expected_fields, "storage-control evidence")
    if root["schema"] != SCHEMA:
        fail("storage-control evidence schema is invalid")
    expected_identity = {
        "provider": provider,
        "controlMode": control_mode,
        "endpoint": endpoint,
        "bucket": bucket,
        "prefix": prefix,
    }
    for field, expected in expected_identity.items():
        if root[field] != expected:
            fail(f"storage-control evidence {field} does not match configuration")

    verified_epoch = canonical_timestamp(root["verifiedAt"], "verifiedAt")
    age_seconds = now_epoch - verified_epoch
    if age_seconds < -MAX_CLOCK_SKEW_SECONDS:
        fail("storage-control evidence is dated in the future")
    if age_seconds > MAX_EVIDENCE_AGE_SECONDS:
        fail("storage-control evidence is older than 30 days")
    reference = root["verificationReference"]
    if not isinstance(reference, str) or not REFERENCE_PATTERN.fullmatch(reference):
        fail("verificationReference must be a bounded private evidence identifier")

    versioning = exact_object(
        root["versioning"],
        {"supported", "status"},
        "versioning evidence",
    )
    release_lock = exact_object(
        root["releasePrefixLock"],
        {"control", "status", "prefix", "retentionDays"},
        "release-prefix lock evidence",
    )
    expected_release_prefix = f"{prefix.rstrip('/')}/releases/"
    if (
        release_lock["status"] != "enabled"
        or release_lock["prefix"] != expected_release_prefix
        or not isinstance(release_lock["retentionDays"], int)
        or isinstance(release_lock["retentionDays"], bool)
        or release_lock["retentionDays"] < 90
    ):
        fail("release-prefix lock must cover the exact releases prefix for at least 90 days")

    if provider == "aws-s3":
        if versioning != {"supported": True, "status": "enabled"}:
            fail("versioned-s3 requires enabled bucket versioning")
        if release_lock["control"] != "s3-object-lock":
            fail("versioned-s3 requires S3 Object Lock evidence for release objects")
    else:
        if versioning != {"supported": False, "status": "not-supported"}:
            fail("R2 variance must explicitly record unavailable S3 versioning")
        if release_lock["control"] != "cloudflare-r2-prefix-lock":
            fail("R2 variance requires Cloudflare release-prefix bucket-lock evidence")
        approval = exact_object(
            root["varianceApproval"],
            {"approvedBy", "approvedAt", "reason"},
            "R2 variance approval",
        )
        if (
            not isinstance(approval["approvedBy"], str)
            or not APPROVER_PATTERN.fullmatch(approval["approvedBy"])
        ):
            fail("R2 variance approvedBy must be a bounded operator identifier")
        approved_epoch = canonical_timestamp(
            approval["approvedAt"],
            "varianceApproval.approvedAt",
        )
        if approved_epoch > verified_epoch:
            fail("R2 variance approval cannot be newer than its control verification")
        if approval["reason"] != "r2-has-no-s3-versioning":
            fail("R2 variance reason is outside the governed schema")

    return {
        "schemaVersion": RESULT_SCHEMA,
        "status": "passed",
        "provider": provider,
        "controlMode": control_mode,
        "versioningRequired": provider == "aws-s3",
        "versioningVerified": provider == "aws-s3",
        "approvedVariance": provider == "cloudflare-r2",
        "releasePrefixLockVerified": True,
        "releaseRetentionDays": release_lock["retentionDays"],
        "evidenceAgeSeconds": max(0, age_seconds),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--control-mode", required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument(
        "--now-epoch",
        type=int,
        default=int(datetime.now(timezone.utc).timestamp()),
    )
    args = parser.parse_args()
    if args.now_epoch < 0:
        fail("now epoch must be non-negative")
    with args.evidence.open(encoding="utf-8") as source:
        evidence = json.load(source)
    result = validate_evidence(
        evidence,
        provider=args.provider,
        control_mode=args.control_mode,
        endpoint=args.endpoint,
        bucket=args.bucket,
        prefix=args.prefix,
        now_epoch=args.now_epoch,
    )
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
