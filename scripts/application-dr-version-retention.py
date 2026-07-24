#!/usr/bin/env python3
"""Produce read-only retention-floor evidence for governed Nexus DR versions."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import stat
from typing import Any, NoReturn


TIER_PATTERNS = {
    "hourly": r"nexus-db-[0-9]{8}T[0-9]{6}Z\.sqlite\.age",
    "daily": r"nexus-db-[0-9]{8}\.sqlite\.age",
    "weekly": r"nexus-db-[0-9]{4}-W[0-9]{2}\.sqlite\.age",
    "monthly": r"nexus-db-[0-9]{6}\.sqlite\.age",
}
REQUIRED_POINTS = {
    "hourly": 24,
    "daily": 7,
    "weekly": 4,
    "monthly": 6,
}
MAX_VERSION_ENTRIES = 20_000
VERSION_LISTING_SCHEMA = "NexusApplicationDrVersionListingV1"
EVIDENCE_SCHEMA = "NexusApplicationDrRetentionEvidenceV1"
MATURITY_SEAL_SCHEMA = "NexusApplicationDrRetentionMaturitySealV1"


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def valid_opaque_utf8(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def valid_version_id(value: Any) -> bool:
    return value != "null" and valid_opaque_utf8(value)


def timestamp(raw: Any, label: str) -> datetime:
    if not isinstance(raw, str):
        fail(f"{label} LastModified is missing")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        fail(f"{label} LastModified is invalid")
    if parsed.tzinfo is None:
        fail(f"{label} LastModified has no timezone")
    return parsed.astimezone(timezone.utc)


def optional_marker(page: dict[str, Any], name: str, label: str) -> str | None:
    raw = page.get(name)
    if raw is None or raw == "":
        return None
    if not valid_opaque_utf8(raw):
        fail(f"{label} {name} is invalid")
    if "VersionId" in name and not valid_version_id(raw):
        fail(f"{label} {name} is invalid")
    return raw


def listing_pages(value: dict[str, Any]) -> list[dict[str, Any]]:
    if "pages" not in value:
        return [value]
    if (
        value.get("schemaVersion") != VERSION_LISTING_SCHEMA
        or not isinstance(value.get("pages"), list)
        or not value["pages"]
        or not all(isinstance(page, dict) for page in value["pages"])
    ):
        fail("version listing page envelope is invalid")
    return value["pages"]


def listing_entries(listing: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        value = json.loads(listing.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"version listing is unreadable: {error}")
    if not isinstance(value, dict):
        fail("version listing must be an object")
    if "pages" in value and "NextToken" in value:
        fail("version listing envelope contains an unconsumed AWS CLI continuation token")
    pages = listing_pages(value)
    versions: list[dict[str, Any]] = []
    markers: list[dict[str, Any]] = []
    expected_key_marker: str | None = None
    expected_version_marker: str | None = None
    for index, page in enumerate(pages):
        label = f"version listing page {index + 1}"
        if "NextToken" in page:
            fail(f"{label} contains an unconsumed AWS CLI continuation token")
        key_marker = optional_marker(page, "KeyMarker", label)
        version_marker = optional_marker(page, "VersionIdMarker", label)
        if index == 0:
            if key_marker is not None or version_marker is not None:
                fail("version listing does not start at the beginning of the prefix")
        elif (
            key_marker != expected_key_marker
            or version_marker != expected_version_marker
        ):
            fail(f"{label} marker chain is invalid")

        is_truncated = page.get("IsTruncated")
        if not isinstance(is_truncated, bool):
            fail(f"{label} IsTruncated must be an explicit boolean")
        has_next_page = index < len(pages) - 1
        if is_truncated != has_next_page:
            fail("version listing pages are not fully exhausted")
        next_key_marker = optional_marker(page, "NextKeyMarker", label)
        next_version_marker = optional_marker(page, "NextVersionIdMarker", label)
        if has_next_page:
            if next_key_marker is None or next_version_marker is None:
                fail(f"{label} continuation markers are incomplete")
            expected_key_marker = next_key_marker
            expected_version_marker = next_version_marker
        elif next_key_marker is not None or next_version_marker is not None:
            fail("final version listing page has continuation markers")

        page_versions = page.get("Versions", [])
        page_markers = page.get("DeleteMarkers", [])
        if not isinstance(page_versions, list) or not isinstance(page_markers, list):
            fail(f"{label} arrays are invalid")
        if not all(
            isinstance(entry, dict)
            for entry in [*page_versions, *page_markers]
        ):
            fail(f"{label} contains a non-object entry")
        versions.extend(page_versions)
        markers.extend(page_markers)
        if len(versions) + len(markers) > MAX_VERSION_ENTRIES:
            fail("version listing exceeds the bounded entry limit")
    return versions, markers


def validated_entry(
    raw: dict[str, Any],
    *,
    kind: str,
    key_pattern: re.Pattern[str],
) -> dict[str, Any] | None:
    key = raw.get("Key")
    if not isinstance(key, str) or not key_pattern.fullmatch(key):
        return None
    version_id = raw.get("VersionId")
    if not valid_version_id(version_id):
        fail(f"governed {kind} has an invalid VersionId: {key}")
    modified_at = timestamp(raw.get("LastModified"), f"governed {kind}")
    is_latest = raw.get("IsLatest")
    if not isinstance(is_latest, bool):
        fail(f"governed {kind} IsLatest is invalid: {key}")
    return {
        "key": key,
        "versionId": version_id,
        "kind": kind,
        "modifiedAt": modified_at,
        "isLatest": is_latest,
    }


def governed_entries(
    listing: Path,
    key_pattern: re.Pattern[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    versions_raw, markers_raw = listing_entries(listing)
    versions = [
        entry
        for raw in versions_raw
        if (entry := validated_entry(raw, kind="version", key_pattern=key_pattern))
        is not None
    ]
    markers = [
        entry
        for raw in markers_raw
        if (
            entry := validated_entry(
                raw,
                kind="delete-marker",
                key_pattern=key_pattern,
            )
        )
        is not None
    ]
    identities = [
        (str(entry["key"]), str(entry["versionId"]))
        for entry in [*versions, *markers]
    ]
    if len(set(identities)) != len(identities):
        fail("governed version listing contains duplicate key/version identities")
    by_key: dict[str, list[dict[str, Any]]] = {}
    for entry in [*versions, *markers]:
        by_key.setdefault(str(entry["key"]), []).append(entry)
    for key, entries in by_key.items():
        latest = [entry for entry in entries if entry["isLatest"] is True]
        if len(latest) != 1:
            fail(f"governed key must have exactly one IsLatest entry: {key}")
        for kind_entries in (
            [entry for entry in versions if entry["key"] == key],
            [entry for entry in markers if entry["key"] == key],
        ):
            if any(
                current["modifiedAt"] < following["modifiedAt"]
                for current, following in zip(kind_entries, kind_entries[1:])
            ):
                fail(f"governed key version order is invalid: {key}")
        latest_entry = latest[0]
        same_kind = (
            [entry for entry in versions if entry["key"] == key]
            if latest_entry["kind"] == "version"
            else [entry for entry in markers if entry["key"] == key]
        )
        if not same_kind or same_kind[0] is not latest_entry:
            fail(f"governed key IsLatest entry is not first in service order: {key}")
    return versions, markers


def tier_key_datetime(key: str, prefix: str, tier: str) -> datetime:
    basename = key.removeprefix(f"{prefix}/{tier}/nexus-db-").removesuffix(
        ".sqlite.age"
    )
    if tier == "hourly":
        value, format_string = basename, "%Y%m%dT%H%M%SZ"
    elif tier == "daily":
        value, format_string = basename, "%Y%m%d"
    elif tier == "weekly":
        value, format_string = f"{basename}-1", "%G-W%V-%u"
    else:
        value, format_string = basename, "%Y%m"
    try:
        parsed = datetime.strptime(value, format_string)
    except ValueError:
        fail(f"governed {tier} key has an invalid calendar value: {key}")
    if parsed.strftime(format_string) != value:
        fail(f"governed {tier} key has an invalid calendar value: {key}")
    return parsed.replace(tzinfo=timezone.utc)


def expected_key_for_period(prefix: str, tier: str, now: datetime) -> str:
    if tier == "hourly":
        fail("hourly expected key must be supplied by the backup transaction")
    suffix = {
        "daily": now.strftime("%Y%m%d"),
        "weekly": now.strftime("%G-W%V"),
        "monthly": now.strftime("%Y%m"),
    }[tier]
    return f"{prefix}/{tier}/nexus-db-{suffix}.sqlite.age"


def period_start(value: datetime, tier: str) -> datetime:
    if tier == "hourly":
        return value.replace(minute=0, second=0, microsecond=0)
    if tier == "daily":
        return value.replace(hour=0, minute=0, second=0, microsecond=0)
    if tier == "weekly":
        start = value - timedelta(days=value.weekday())
        return start.replace(hour=0, minute=0, second=0, microsecond=0)
    return value.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def period_identity(value: datetime, tier: str) -> str:
    start = period_start(value, tier)
    return {
        "hourly": start.strftime("%Y-%m-%dT%H"),
        "daily": start.strftime("%Y-%m-%d"),
        "weekly": start.strftime("%G-W%V"),
        "monthly": start.strftime("%Y-%m"),
    }[tier]


def subtract_months(value: datetime, months: int) -> datetime:
    absolute = value.year * 12 + value.month - 1 - months
    return value.replace(year=absolute // 12, month=absolute % 12 + 1)


def required_period_identities(tier: str, now: datetime, count: int) -> list[str]:
    current = period_start(now, tier)
    values: list[datetime] = []
    for offset in range(count):
        if tier == "hourly":
            values.append(current - timedelta(hours=offset))
        elif tier == "daily":
            values.append(current - timedelta(days=offset))
        elif tier == "weekly":
            values.append(current - timedelta(weeks=offset))
        else:
            values.append(subtract_months(current, offset))
    return [period_identity(value, tier) for value in values]


def retention_evidence(
    listing: Path,
    prefix: str,
    expected_keys: dict[str, str],
    now: datetime,
) -> dict[str, Any]:
    all_pattern = re.compile(
        rf"^{re.escape(prefix)}/(?:"
        + "|".join(
            rf"{re.escape(tier)}/{pattern}"
            for tier, pattern in TIER_PATTERNS.items()
        )
        + r")$"
    )
    versions, markers = governed_entries(listing, all_pattern)
    evidence: dict[str, Any] = {}
    floor_observed = True
    for tier, required in REQUIRED_POINTS.items():
        tier_pattern = re.compile(
            rf"^{re.escape(prefix)}/{re.escape(tier)}/{TIER_PATTERNS[tier]}$"
        )
        tier_versions = [
            entry
            for entry in versions
            if tier_pattern.fullmatch(str(entry["key"]))
        ]
        tier_markers = [
            entry
            for entry in markers
            if tier_pattern.fullmatch(str(entry["key"]))
        ]
        for entry in [*tier_versions, *tier_markers]:
            tier_key_datetime(str(entry["key"]), prefix, tier)
        visible_versions = {
            str(entry["key"]): entry
            for entry in tier_versions
            if entry["isLatest"] is True
        }
        hidden_keys = {
            str(entry["key"])
            for entry in tier_markers
            if entry["isLatest"] is True
        }
        expected_key = expected_keys[tier]
        if not tier_pattern.fullmatch(expected_key):
            fail(f"expected {tier} key is outside the governed namespace")
        if tier == "hourly":
            expected_at = tier_key_datetime(expected_key, prefix, tier)
            age_seconds = int((now - expected_at).total_seconds())
            if age_seconds < 0 or age_seconds > 7200:
                fail("expected hourly key is not a recent transaction key")
        elif expected_key != expected_key_for_period(prefix, tier, now):
            fail(f"expected {tier} key does not match the current UTC period")
        if expected_key not in visible_versions or expected_key in hidden_keys:
            fail(f"current {tier} recovery point is not visibly retained")
        visible_by_period: dict[str, dict[str, Any]] = {}
        current_period = period_start(now, tier)
        for key, entry in visible_versions.items():
            key_time = tier_key_datetime(key, prefix, tier)
            key_period = period_start(key_time, tier)
            if (
                (tier == "hourly" and key_time > now)
                or key_period > current_period
            ):
                fail(f"governed {tier} key is in a future calendar period: {key}")
            identity = period_identity(key_time, tier)
            selected = visible_by_period.get(identity)
            if selected is None or key_time > selected["keyTime"]:
                visible_by_period[identity] = {
                    "entry": entry,
                    "keyTime": key_time,
                }
        required_periods = required_period_identities(tier, now, required)
        selected_versions = [
            {
                "calendarPeriod": identity,
                "key": str(visible_by_period[identity]["entry"]["key"]),
                "versionId": str(
                    visible_by_period[identity]["entry"]["versionId"],
                ),
            }
            for identity in required_periods
            if identity in visible_by_period
        ]
        consecutive_floor = len(selected_versions) == required
        observed = len(visible_versions)
        floor_observed = floor_observed and consecutive_floor
        version_counts: dict[str, int] = {}
        for entry in tier_versions:
            version_counts[str(entry["key"])] = (
                version_counts.get(str(entry["key"]), 0) + 1
            )
        evidence[tier] = {
            "requiredPoints": required,
            "visiblePoints": observed,
            "currentKey": expected_key,
            "currentKeyPresent": True,
            "coveredRequiredPeriods": len(selected_versions),
            "consecutiveRequiredPeriodsPresent": consecutive_floor,
            "multipleVersionKeys": sum(
                1 for count in version_counts.values() if count > 1
            ),
            "selectedVersions": selected_versions,
            "latestVisibleKey": max(
                visible_versions,
                key=lambda key: tier_key_datetime(key, prefix, tier),
            ),
        }
    return {
        "schemaVersion": EVIDENCE_SCHEMA,
        "inventoryOnly": True,
        "policyConfigured": dict(REQUIRED_POINTS),
        "floorObserved": floor_observed,
        "maturityStatus": "mature" if floor_observed else "warming",
        "maturitySealed": False,
        "selectedObjectsVerified": False,
        "currentPeriodsVerified": True,
        "observedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tiers": evidence,
    }


def enforce_maturity_seal(
    seal: Path,
    *,
    bucket: str,
    prefix: str,
    evidence: dict[str, Any],
) -> bool:
    expected = {
        "schemaVersion": MATURITY_SEAL_SCHEMA,
        "bucket": bucket,
        "prefix": prefix,
        "policyConfigured": dict(REQUIRED_POINTS),
    }
    if seal.is_symlink():
        fail("retention maturity seal must not be a symlink")
    if seal.exists():
        try:
            status = seal.stat()
            value = json.loads(seal.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            fail(f"retention maturity seal is unreadable: {error}")
        if (
            not stat.S_ISREG(status.st_mode)
            or stat.S_IMODE(status.st_mode) != 0o600
            or status.st_uid != os.geteuid()
            or not isinstance(value, dict)
            or any(value.get(key) != item for key, item in expected.items())
            or not isinstance(value.get("maturedAt"), str)
        ):
            fail("retention maturity seal is invalid")
        if evidence.get("floorObserved") is not True:
            fail("sealed retention maturity regressed below the 24/7/4/6 floor")
        return True
    if evidence.get("floorObserved") is not True:
        return False
    if not seal.parent.is_dir() or seal.parent.is_symlink():
        fail("retention maturity seal parent is unsafe")
    temporary = seal.with_name(f".{seal.name}.next")
    if temporary.exists() or temporary.is_symlink():
        fail("retention maturity seal temporary path already exists")
    payload = {
        **expected,
        "maturedAt": evidence["observedAt"],
    }
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(
                json.dumps(payload, sort_keys=True, separators=(",", ":"))
                + "\n"
            )
            target.flush()
            os.fsync(target.fileno())
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    temporary.replace(seal)
    return True


def write_evidence(output: Path, payload: dict[str, Any]) -> None:
    if output.exists() or output.is_symlink():
        fail("retention evidence output must be a new path")
    if not output.parent.is_dir() or output.parent.is_symlink():
        fail("retention evidence output parent is unsafe")
    temporary = output.with_name(f".{output.name}.next")
    if temporary.exists() or temporary.is_symlink():
        fail("retention evidence temporary path already exists")
    temporary.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temporary.chmod(0o600)
    temporary.replace(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listing", type=Path, required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--now-epoch", type=int, required=True)
    parser.add_argument("--maturity-seal", type=Path)
    parser.add_argument("--bucket")
    for tier in REQUIRED_POINTS:
        parser.add_argument(f"--expected-{tier}-key", required=True)
    args = parser.parse_args()
    if not args.listing.is_file() or args.listing.is_symlink():
        fail("version listing must be a regular non-symlink file")
    prefix = args.prefix.rstrip("/")
    if (
        not prefix
        or prefix.startswith("/")
        or ".." in prefix
        or "//" in prefix
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]", prefix)
    ):
        fail("version retention prefix is invalid")
    if args.now_epoch < 1:
        fail("retention evidence time is invalid")
    now = datetime.fromtimestamp(args.now_epoch, timezone.utc)
    expected_keys = {
        tier: str(getattr(args, f"expected_{tier}_key"))
        for tier in REQUIRED_POINTS
    }
    if (args.maturity_seal is None) != (args.bucket is None):
        fail("maturity seal and bucket must be supplied together")
    if args.bucket is not None and not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]",
        args.bucket,
    ):
        fail("retention maturity bucket is invalid")
    evidence = retention_evidence(args.listing, prefix, expected_keys, now)
    if args.maturity_seal is not None:
        evidence["maturitySealed"] = enforce_maturity_seal(
            args.maturity_seal,
            bucket=args.bucket,
            prefix=prefix,
            evidence=evidence,
        )
    write_evidence(
        args.output,
        evidence,
    )


if __name__ == "__main__":
    main()
