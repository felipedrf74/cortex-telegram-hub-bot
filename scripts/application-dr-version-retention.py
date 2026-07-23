#!/usr/bin/env python3
"""Plan exact version deletion for governed Nexus DR S3 namespaces."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
from typing import Any, NoReturn


TIER_PATTERNS = {
    "hourly": r"nexus-db-[0-9]{8}T[0-9]{6}Z\.sqlite\.age",
    "daily": r"nexus-db-[0-9]{8}\.sqlite\.age",
    "weekly": r"nexus-db-[0-9]{4}-W[0-9]{2}\.sqlite\.age",
    "monthly": r"nexus-db-[0-9]{6}\.sqlite\.age",
}
RELEASE_PATTERN = r"v[A-Za-z0-9._+-]+\.tar\.gz\.[0-9a-f]{64}\.age"
VERSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9._~+=:/-]{1,1024}$")
MAX_VERSION_ENTRIES = 20_000
VERSION_LISTING_SCHEMA = "NexusApplicationDrVersionListingV1"


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


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
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > 1024:
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
    if not isinstance(version_id, str) or not VERSION_ID_PATTERN.fullmatch(version_id):
        fail(f"governed {kind} has an invalid VersionId: {key}")
    modified_epoch = timestamp(raw.get("LastModified"), f"governed {kind}")
    is_latest = raw.get("IsLatest")
    if not isinstance(is_latest, bool):
        fail(f"governed {kind} IsLatest is invalid: {key}")
    return {
        "key": key,
        "versionId": version_id,
        "kind": kind,
        "modifiedAt": modified_epoch,
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
        if (entry := validated_entry(raw, kind="delete-marker", key_pattern=key_pattern))
        is not None
    ]
    identities = [(entry["key"], entry["versionId"]) for entry in [*versions, *markers]]
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


def count_plan(
    listing: Path,
    prefix: str,
    tier: str,
    retain: int,
) -> list[dict[str, str]]:
    if tier not in TIER_PATTERNS or retain < 1:
        fail("invalid versioned count-retention policy")
    key_pattern = re.compile(
        rf"^{re.escape(prefix)}/{re.escape(tier)}/{TIER_PATTERNS[tier]}$"
    )
    versions, markers = governed_entries(listing, key_pattern)
    for entry in [*versions, *markers]:
        tier_key_datetime(str(entry["key"]), prefix, tier)
    keys = sorted(
        {str(entry["key"]) for entry in versions},
        key=lambda key: tier_key_datetime(key, prefix, tier),
        reverse=True,
    )
    retained_keys = set(keys[:retain])
    kept_identities: set[tuple[str, str]] = set()
    for key in retained_keys:
        candidates = [entry for entry in versions if entry["key"] == key]
        if not candidates:
            continue
        newest = candidates[0]
        kept_identities.add((str(newest["key"]), str(newest["versionId"])))
    deletions = [
        entry
        for entry in versions
        if (str(entry["key"]), str(entry["versionId"])) not in kept_identities
    ]
    deletions.extend(markers)
    return deletion_rows(deletions)


def age_plan(
    listing: Path,
    prefix: str,
    days: int,
    now_epoch: int,
    grace_seconds: int,
) -> list[dict[str, str]]:
    if days < 1 or now_epoch < 1 or grace_seconds < 0 or grace_seconds > 86_400:
        fail("invalid versioned age-retention policy")
    key_pattern = re.compile(
        rf"^{re.escape(prefix)}/releases/{RELEASE_PATTERN}$"
    )
    versions, markers = governed_entries(listing, key_pattern)
    cutoff = datetime.fromtimestamp(now_epoch, timezone.utc) - timedelta(
        days=days,
        seconds=grace_seconds,
    )
    deletions = [
        entry for entry in versions if entry["modifiedAt"] < cutoff
    ]
    # A delete marker can hide a compliance-locked rollback version without
    # deleting it. Remove every governed marker so every retained bundle stays
    # addressable by its exact key. deletion_rows keeps versions before markers
    # for the same key, allowing a fail-fast consumer to stop on Object Lock.
    deletions.extend(markers)
    return deletion_rows(deletions)


def deletion_rows(entries: list[dict[str, Any]]) -> list[dict[str, str]]:
    kind_order = {"version": 0, "delete-marker": 1}
    return [
        {
            "key": str(entry["key"]),
            "versionId": str(entry["versionId"]),
            "kind": str(entry["kind"]),
        }
        for entry in sorted(
            entries,
            key=lambda item: (
                str(item["key"]),
                kind_order[str(item["kind"])],
                str(item["versionId"]),
            ),
        )
    ]


def write_plan(output: Path, deletions: list[dict[str, str]]) -> None:
    if output.exists() or output.is_symlink():
        fail("version deletion output must be a new path")
    if not output.parent.is_dir() or output.parent.is_symlink():
        fail("version deletion output parent is unsafe")
    temporary = output.with_name(f".{output.name}.next")
    if temporary.exists() or temporary.is_symlink():
        fail("version deletion temporary path already exists")
    payload = {
        "schemaVersion": "NexusApplicationDrVersionDeletionPlanV1",
        "deletions": deletions,
    }
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
    subparsers = parser.add_subparsers(dest="command", required=True)
    count_parser = subparsers.add_parser("count")
    count_parser.add_argument("--tier", choices=sorted(TIER_PATTERNS), required=True)
    count_parser.add_argument("--retain", type=int, required=True)
    age_parser = subparsers.add_parser("age")
    age_parser.add_argument("--days", type=int, required=True)
    age_parser.add_argument("--now-epoch", type=int, required=True)
    age_parser.add_argument("--grace-seconds", type=int, default=3600)
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
    deletions = (
        count_plan(args.listing, prefix, args.tier, args.retain)
        if args.command == "count"
        else age_plan(
            args.listing,
            prefix,
            args.days,
            args.now_epoch,
            args.grace_seconds,
        )
    )
    write_plan(args.output, deletions)


if __name__ == "__main__":
    main()
