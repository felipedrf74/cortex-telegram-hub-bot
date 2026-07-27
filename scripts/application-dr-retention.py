#!/usr/bin/env python3
"""Produce conservative deletion plans for governed Nexus DR namespaces."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re


TIER_PATTERNS = {
    "hourly": r"nexus-db-[0-9]{8}T[0-9]{6}Z\.sqlite\.age",
    "daily": r"nexus-db-[0-9]{8}\.sqlite\.age",
    "weekly": r"nexus-db-[0-9]{4}-W[0-9]{2}\.sqlite\.age",
    "monthly": r"nexus-db-[0-9]{6}\.sqlite\.age",
}
RELEASE_PATTERN = (
    r"v[A-Za-z0-9._+-]+\.tar\.gz\.[0-9a-f]{64}\.age"
)


def contents(listing: Path) -> list[dict[str, object]]:
    parsed = json.loads(listing.read_text(encoding="utf-8"))
    values = parsed.get("Contents", [])
    if not isinstance(values, list):
        raise SystemExit("S3 listing Contents must be an array")
    return [value for value in values if isinstance(value, dict)]


def count_plan(listing: Path, prefix: str, tier: str, retain: int) -> list[str]:
    if tier not in TIER_PATTERNS or retain < 1:
        raise SystemExit("invalid count-retention policy")
    pattern = re.compile(rf"^{re.escape(prefix)}/{tier}/{TIER_PATTERNS[tier]}$")
    keys = sorted(
        (str(item.get("Key", "")) for item in contents(listing)), reverse=True
    )
    return [key for key in keys if pattern.fullmatch(key)][retain:]


def age_plan(listing: Path, prefix: str, days: int, now_epoch: int) -> list[str]:
    if days < 1 or now_epoch < 1:
        raise SystemExit("invalid age-retention policy")
    pattern = re.compile(rf"^{re.escape(prefix)}/releases/{RELEASE_PATTERN}$")
    cutoff = now_epoch - days * 24 * 60 * 60
    deletions: list[str] = []
    for item in contents(listing):
        key = str(item.get("Key", ""))
        modified = item.get("LastModified")
        if not pattern.fullmatch(key) or not isinstance(modified, str):
            continue
        try:
            parsed = datetime.fromisoformat(modified.replace("Z", "+00:00"))
        except ValueError as error:
            raise SystemExit(f"invalid LastModified for governed release object: {key}") from error
        if parsed.tzinfo is None:
            raise SystemExit(f"timezone missing from LastModified: {key}")
        if int(parsed.astimezone(timezone.utc).timestamp()) < cutoff:
            deletions.append(key)
    return sorted(deletions)


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
    args = parser.parse_args()
    if not args.listing.is_file():
        raise SystemExit("listing must be a regular file")
    planned = (
        count_plan(args.listing, args.prefix, args.tier, args.retain)
        if args.command == "count"
        else age_plan(args.listing, args.prefix, args.days, args.now_epoch)
    )
    args.output.write_text("".join(f"{key}\n" for key in planned), encoding="utf-8")
    args.output.chmod(0o600)


if __name__ == "__main__":
    main()
