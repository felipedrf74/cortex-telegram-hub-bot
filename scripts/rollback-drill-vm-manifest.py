#!/usr/bin/env python3
"""Strictly select one Ubuntu cloud image digest from a signed SHA256SUMS file."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


SHA256 = re.compile(r"^[0-9a-f]{64}$")
SUM_LINE = re.compile(r"^([0-9a-f]{64}) [ *](\S+)$")
MAX_MANIFEST_BYTES = 2 * 1024 * 1024


def fail(message: str) -> None:
    raise SystemExit(f"rollback drill VM manifest: {message}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Select an exact image digest after the caller has verified "
            "SHA256SUMS.gpg with Ubuntu's cloud-image keyring."
        )
    )
    parser.add_argument("--checksums", required=True)
    parser.add_argument("--filename", required=True)
    parser.add_argument("--expected-sha256", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not SHA256.fullmatch(args.expected_sha256):
        fail("expected SHA-256 must be 64 lowercase hexadecimal characters")
    if (
        not args.filename
        or "/" in args.filename
        or "\\" in args.filename
        or args.filename in {".", ".."}
    ):
        fail("filename must be one safe basename")

    path = Path(args.checksums)
    try:
        stat = path.lstat()
    except OSError as error:
        fail(f"cannot stat checksum manifest: {error}")
    if path.is_symlink() or not path.is_file():
        fail("checksum manifest must be a regular non-symlink file")
    if stat.st_size <= 0 or stat.st_size > MAX_MANIFEST_BYTES:
        fail("checksum manifest size is outside the accepted bound")
    try:
        text = path.read_text(encoding="utf-8", errors="strict")
    except (OSError, UnicodeError) as error:
        fail(f"cannot read checksum manifest: {error}")

    matches: list[str] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line:
            continue
        match = SUM_LINE.fullmatch(line)
        if match is None:
            fail(f"malformed checksum line {line_number}")
        digest, filename = match.groups()
        if filename == args.filename:
            matches.append(digest)

    if len(matches) != 1:
        fail("signed manifest must contain exactly one target image entry")
    digest = matches[0]
    if digest != args.expected_sha256:
        fail("owner-reviewed image SHA-256 differs from the signed manifest")

    json.dump(
        {
            "schema": "nexus.rollback-drill-vm-image-selection.v1",
            "filename": args.filename,
            "sha256": digest,
        },
        sys.stdout,
        separators=(",", ":"),
        sort_keys=True,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
