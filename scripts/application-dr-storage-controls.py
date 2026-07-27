#!/usr/bin/env python3
"""Validate owner-retained object-store control evidence for application DR."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any, NoReturn


SCHEMA = "nexus.application-dr-storage-controls.v2"
BOOTSTRAP_SCHEMA = "nexus.application-dr-storage-controls.bootstrap.v1"
RESULT_SCHEMA = "NexusApplicationDrStorageControlsVerificationV2"
BOOTSTRAP_RESULT_SCHEMA = (
    "NexusApplicationDrStorageControlsBootstrapVerificationV1"
)
MAX_EVIDENCE_AGE_SECONDS = 30 * 24 * 60 * 60
MAX_CLOCK_SKEW_SECONDS = 5 * 60
DATABASE_RETENTION_FLOOR_DAYS = {
    "hourly": 2,
    "daily": 8,
    "weekly": 35,
    "monthly": 190,
}
DATABASE_LIFECYCLE_EXPIRATION_DAYS = {
    "hourly": 3,
    "daily": 9,
    "weekly": 36,
    "monthly": 191,
}
DATABASE_RETAINED_COUNTS = {
    "hourly": 24,
    "daily": 7,
    "weekly": 4,
    "monthly": 6,
}
RELEASE_LIFECYCLE_EXPIRATION_DAYS = 92
PROVIDER_MODES = {
    "aws-s3": "versioned-s3",
    "cloudflare-r2": "r2-approved-variance",
}
REFERENCE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+-]{5,255}$")
APPROVER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$")
STACK_ID_PATTERN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):cloudformation:"
    r"([a-z0-9-]+):([0-9]{12}):stack/"
    r"([A-Za-z][A-Za-z0-9-]{0,127})/"
    r"([A-Za-z0-9-]{1,128})$",
)
STACK_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,127}$")


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


def exact_integer_map(
    value: Any,
    expected: dict[str, int],
    label: str,
) -> dict[str, int]:
    result = exact_object(value, set(expected), label)
    if any(
        isinstance(result[key], bool)
        or not isinstance(result[key], int)
        or result[key] != expected_value
        for key, expected_value in expected.items()
    ):
        fail(f"{label} does not match the governed values")
    return result


def validate_common_identity(
    root: dict[str, Any],
    *,
    provider: str,
    control_mode: str,
    endpoint: str,
    bucket: str,
    prefix: str,
    now_epoch: int,
) -> tuple[int, int]:
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
    return verified_epoch, age_seconds


def validate_aws_write_once_controls(
    root: dict[str, Any],
    *,
    prefix: str,
    lifecycle_status: str,
) -> dict[str, Any]:
    versioning = exact_object(
        root["versioning"],
        {"supported", "status"},
        "versioning evidence",
    )
    if versioning != {"supported": True, "status": "enabled"}:
        fail("versioned-s3 requires enabled bucket versioning")

    database_protection = exact_object(
        root["databaseProtection"],
        {"writeMode", "objectLock"},
        "AWS database-protection evidence",
    )
    if database_protection["writeMode"] != "conditional-first-point":
        fail("versioned-s3 requires conditional first-point database writes")
    database_lock = exact_object(
        database_protection["objectLock"],
        {"supported", "status", "mode", "retentionFloorDays"},
        "AWS database Object Lock evidence",
    )
    if (
        database_lock["supported"] is not True
        or database_lock["status"] != "enabled"
        or database_lock["mode"] != "COMPLIANCE"
    ):
        fail("versioned-s3 requires enabled COMPLIANCE locks for database tiers")
    exact_integer_map(
        database_lock["retentionFloorDays"],
        DATABASE_RETENTION_FLOOR_DAYS,
        "AWS database retention floors",
    )

    cleanup = exact_object(
        root["cleanup"],
        {
            "owner",
            "status",
            "databaseExpirationDays",
            "releaseExpirationDays",
        },
        "AWS cleanup evidence",
    )
    if (
        cleanup["owner"] != "s3-lifecycle"
        or cleanup["status"] != lifecycle_status
    ):
        fail(
            "versioned-s3 requires "
            f"{lifecycle_status} S3 Lifecycle owned cleanup",
        )
    exact_integer_map(
        cleanup["databaseExpirationDays"],
        DATABASE_LIFECYCLE_EXPIRATION_DAYS,
        "AWS database lifecycle expiration",
    )
    if (
        isinstance(cleanup["releaseExpirationDays"], bool)
        or cleanup["releaseExpirationDays"]
        != RELEASE_LIFECYCLE_EXPIRATION_DAYS
    ):
        fail("AWS release lifecycle expiration must equal 92 days")

    release_lock = exact_object(
        root["releasePrefixLock"],
        {"control", "status", "prefix", "retentionDays"},
        "release-prefix lock evidence",
    )
    expected_release_prefix = f"{prefix.rstrip('/')}/releases/"
    if (
        release_lock["control"] != "s3-object-lock"
        or release_lock["status"] != "enabled"
        or release_lock["prefix"] != expected_release_prefix
        or not isinstance(release_lock["retentionDays"], int)
        or isinstance(release_lock["retentionDays"], bool)
        or release_lock["retentionDays"] < 90
    ):
        fail(
            "release-prefix lock must cover the exact releases prefix "
            "for at least 90 days",
        )
    return release_lock


def validate_bootstrap_evidence(
    evidence: Any,
    *,
    provider: str,
    control_mode: str,
    endpoint: str,
    bucket: str,
    prefix: str,
    now_epoch: int,
) -> dict[str, Any]:
    if provider != "aws-s3" or control_mode != "versioned-s3":
        fail("disabled-bootstrap is available only for aws-s3:versioned-s3")
    root = exact_object(
        evidence,
        {
            "schema",
            "provider",
            "controlMode",
            "endpoint",
            "bucket",
            "prefix",
            "verifiedAt",
            "verificationReference",
            "cloudFormation",
            "versioning",
            "encryption",
            "publicAccessBlock",
            "ownershipControls",
            "objectLock",
            "databaseProtection",
            "cleanup",
            "releasePrefixLock",
            "namespaceInventory",
        },
        "bootstrap storage-control evidence",
    )
    if root["schema"] != BOOTSTRAP_SCHEMA:
        fail("bootstrap storage-control evidence schema is invalid")
    verified_epoch, age_seconds = validate_common_identity(
        root,
        provider=provider,
        control_mode=control_mode,
        endpoint=endpoint,
        bucket=bucket,
        prefix=prefix,
        now_epoch=now_epoch,
    )

    stack = exact_object(
        root["cloudFormation"],
        {
            "stackId",
            "stackName",
            "stackStatus",
            "changeSetType",
            "createdAt",
            "lastUpdatedAt",
            "lifecycleActivation",
            "lifecycleEverEnabled",
            "lifecycleBootstrapReceiptSha256",
        },
        "bootstrap CloudFormation evidence",
    )
    stack_id = stack["stackId"]
    stack_match = (
        STACK_ID_PATTERN.fullmatch(stack_id)
        if isinstance(stack_id, str)
        else None
    )
    if stack_match is None:
        fail("bootstrap stackId is invalid")
    stack_name = stack["stackName"]
    if (
        not isinstance(stack_name, str)
        or not STACK_NAME_PATTERN.fullmatch(stack_name)
        or stack_match.group(4) != stack_name
    ):
        fail("bootstrap stackName does not match stackId")
    endpoint_match = re.fullmatch(
        r"https://s3\.([a-z0-9-]+)\.amazonaws\.com",
        endpoint,
    )
    if endpoint_match is None or stack_match.group(2) != endpoint_match.group(1):
        fail("bootstrap stack region does not match the configured S3 endpoint")
    created_epoch = canonical_timestamp(
        stack["createdAt"],
        "cloudFormation.createdAt",
    )
    if created_epoch > verified_epoch:
        fail("bootstrap stack creation cannot be newer than its control verification")
    change_set_type = stack["changeSetType"]
    stack_status = stack["stackStatus"]
    last_updated_at = stack["lastUpdatedAt"]
    if change_set_type == "CREATE":
        stack_operation_valid = (
            stack_status == "CREATE_COMPLETE"
            and last_updated_at is None
        )
    elif change_set_type == "UPDATE":
        if last_updated_at is None:
            stack_operation_valid = False
        else:
            last_updated_epoch = canonical_timestamp(
                last_updated_at,
                "cloudFormation.lastUpdatedAt",
            )
            stack_operation_valid = (
                stack_status == "UPDATE_COMPLETE"
                and created_epoch <= last_updated_epoch <= verified_epoch
            )
    else:
        stack_operation_valid = False
    if (
        not stack_operation_valid
        or stack["lifecycleActivation"] != "DISABLED"
        or stack["lifecycleEverEnabled"] is not False
        or stack["lifecycleBootstrapReceiptSha256"] is not None
    ):
        fail(
            "disabled-bootstrap requires a completed CREATE or UPDATE stack "
            "whose lifecycle has never been enabled and has no prior receipt",
        )

    encryption = exact_object(
        root["encryption"],
        {"algorithm"},
        "bootstrap bucket encryption evidence",
    )
    if encryption != {"algorithm": "AES256"}:
        fail("disabled-bootstrap requires exact AES256 bucket encryption")
    public_access = exact_object(
        root["publicAccessBlock"],
        {
            "blockPublicAcls",
            "blockPublicPolicy",
            "ignorePublicAcls",
            "restrictPublicBuckets",
        },
        "bootstrap public-access-block evidence",
    )
    if any(value is not True for value in public_access.values()):
        fail("disabled-bootstrap requires every S3 public-access block")
    ownership = exact_object(
        root["ownershipControls"],
        {"objectOwnership"},
        "bootstrap ownership evidence",
    )
    if ownership != {"objectOwnership": "BucketOwnerEnforced"}:
        fail("disabled-bootstrap requires BucketOwnerEnforced ownership")
    object_lock = exact_object(
        root["objectLock"],
        {"enabled"},
        "bootstrap bucket Object Lock evidence",
    )
    if object_lock != {"enabled": True}:
        fail("disabled-bootstrap requires bucket Object Lock")

    release_lock = validate_aws_write_once_controls(
        root,
        prefix=prefix,
        lifecycle_status="disabled",
    )
    inventory = exact_object(
        root["namespaceInventory"],
        {
            "listingComplete",
            "objectCount",
            "versionCount",
            "deleteMarkerCount",
        },
        "bootstrap namespace inventory",
    )
    if (
        inventory["listingComplete"] is not True
        or any(
            isinstance(inventory[field], bool)
            or not isinstance(inventory[field], int)
            or inventory[field] != 0
            for field in ("objectCount", "versionCount", "deleteMarkerCount")
        )
    ):
        fail(
            "disabled-bootstrap requires a complete zero-object, zero-version, "
            "zero-delete-marker namespace inventory",
        )

    return {
        "schemaVersion": BOOTSTRAP_RESULT_SCHEMA,
        "status": "passed",
        "provider": provider,
        "controlMode": control_mode,
        "lifecyclePhase": "disabled-bootstrap",
        "bootstrapStackId": stack_id,
        "namespaceEmpty": True,
        "versioningRequired": True,
        "versioningVerified": True,
        "approvedVariance": False,
        "databaseWriteOnceVerified": True,
        "databaseObjectLockVerified": True,
        "cleanupOwner": "s3-lifecycle",
        "lifecycleVerified": False,
        "releasePrefixLockVerified": True,
        "releaseRetentionDays": release_lock["retentionDays"],
        "evidenceAgeSeconds": max(0, age_seconds),
    }


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
    if isinstance(evidence, dict) and evidence.get("schema") == BOOTSTRAP_SCHEMA:
        return validate_bootstrap_evidence(
            evidence,
            provider=provider,
            control_mode=control_mode,
            endpoint=endpoint,
            bucket=bucket,
            prefix=prefix,
            now_epoch=now_epoch,
        )
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
        "databaseProtection",
        "cleanup",
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
    verified_epoch, age_seconds = validate_common_identity(
        root,
        provider=provider,
        control_mode=control_mode,
        endpoint=endpoint,
        bucket=bucket,
        prefix=prefix,
        now_epoch=now_epoch,
    )

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
        release_lock = validate_aws_write_once_controls(
            root,
            prefix=prefix,
            lifecycle_status="enabled",
        )
    else:
        if versioning != {"supported": False, "status": "not-supported"}:
            fail("R2 variance must explicitly record unavailable S3 versioning")
        if release_lock["control"] != "cloudflare-r2-prefix-lock":
            fail("R2 variance requires Cloudflare release-prefix bucket-lock evidence")
        database_protection = exact_object(
            root["databaseProtection"],
            {"writeMode", "objectLock", "retentionVariance"},
            "R2 database-protection evidence",
        )
        r2_database_lock = exact_object(
            database_protection["objectLock"],
            {"supported", "status"},
            "R2 database Object Lock evidence",
        )
        if (
            database_protection["writeMode"] != "mutable-period-key"
            or database_protection["retentionVariance"] != "client-count-pruning"
            or r2_database_lock
            != {"supported": False, "status": "not-supported"}
        ):
            fail(
                "R2 variance must explicitly record mutable database keys, "
                "unavailable Object Lock, and client pruning",
            )
        cleanup = exact_object(
            root["cleanup"],
            {
                "owner",
                "status",
                "databaseRetainedCounts",
                "releaseAgeDays",
            },
            "R2 cleanup evidence",
        )
        if cleanup["owner"] != "client-side-pruning" or cleanup["status"] != "enabled":
            fail("R2 variance requires enabled client-side pruning")
        exact_integer_map(
            cleanup["databaseRetainedCounts"],
            DATABASE_RETAINED_COUNTS,
            "R2 database retained counts",
        )
        if (
            isinstance(cleanup["releaseAgeDays"], bool)
            or cleanup["releaseAgeDays"] != 90
        ):
            fail("R2 release pruning age must equal 90 days")
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
        if (
            approval["reason"]
            != "r2-has-no-versioning-or-database-object-lock"
        ):
            fail("R2 variance reason is outside the governed schema")

    return {
        "schemaVersion": RESULT_SCHEMA,
        "status": "passed",
        "provider": provider,
        "controlMode": control_mode,
        "lifecyclePhase": (
            "enabled"
            if provider == "aws-s3"
            else "approved-r2-variance"
        ),
        "versioningRequired": provider == "aws-s3",
        "versioningVerified": provider == "aws-s3",
        "approvedVariance": provider == "cloudflare-r2",
        "databaseWriteOnceVerified": provider == "aws-s3",
        "databaseObjectLockVerified": provider == "aws-s3",
        "cleanupOwner": (
            "s3-lifecycle"
            if provider == "aws-s3"
            else "client-side-pruning"
        ),
        "lifecycleVerified": provider == "aws-s3",
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
