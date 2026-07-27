#!/usr/bin/env python3
"""Derive the controller's canonical stack-parameter digest without values."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Any, NoReturn


SCHEMA = "NexusApplicationDrCloudFormationParametersDigestV1"
MAX_JSON_BYTES = 8 * 1024 * 1024


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def private_file(
    path: Path,
    *,
    owner_uid: int,
    boundary: Path,
) -> None:
    if not path.is_absolute() or path == Path("/"):
        fail("describe-stacks input must be an absolute non-root path")
    try:
        metadata = path.lstat()
        canonical = path.resolve(strict=True)
        canonical_boundary = boundary.resolve(strict=True)
    except OSError as error:
        fail(f"describe-stacks input is unavailable: {error}")
    if (
        canonical != path
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != owner_uid
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        fail("describe-stacks input must be a canonical owner-private file")
    try:
        path.relative_to(canonical_boundary)
    except ValueError:
        fail("describe-stacks input is outside the trusted boundary")
    current = path.parent
    while True:
        current_metadata = current.lstat()
        if (
            current.resolve(strict=True) != current
            or stat.S_ISLNK(current_metadata.st_mode)
            or not stat.S_ISDIR(current_metadata.st_mode)
            or current_metadata.st_uid != owner_uid
            or stat.S_IMODE(current_metadata.st_mode) & 0o022
        ):
            fail("describe-stacks input parent chain is untrusted")
        if current == canonical_boundary:
            break
        if current == current.parent:
            fail("describe-stacks input did not reach the trusted boundary")
        current = current.parent


def normalized_parameters(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        fail("stack parameters are invalid")
    parameters: dict[str, str] = {}
    for entry in value:
        if not isinstance(entry, dict):
            fail("stack parameter entry is invalid")
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
            fail("stack parameters are not exact explicit string values")
        parameters[key] = parameter_value
    return [
        {"ParameterKey": key, "ParameterValue": parameters[key]}
        for key in sorted(parameters)
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--describe-stacks-json", required=True, type=Path)
    parser.add_argument("--expected-owner-uid", required=True, type=int)
    parser.add_argument("--trust-boundary", required=True, type=Path)
    args = parser.parse_args()
    if args.expected_owner_uid < 0:
        fail("expected owner UID is invalid")
    private_file(
        args.describe_stacks_json,
        owner_uid=args.expected_owner_uid,
        boundary=args.trust_boundary,
    )
    try:
        body = args.describe_stacks_json.read_bytes()
    except OSError as error:
        fail(f"describe-stacks input is unreadable: {error}")
    if not body or len(body) > MAX_JSON_BYTES:
        fail("describe-stacks input size is outside its bound")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"describe-stacks input is invalid JSON: {error}")
    stacks = payload.get("Stacks") if isinstance(payload, dict) else None
    if (
        not isinstance(stacks, list)
        or len(stacks) != 1
        or not isinstance(stacks[0], dict)
        or not isinstance(stacks[0].get("StackId"), str)
        or not stacks[0]["StackId"]
    ):
        fail("describe-stacks input must contain exactly one identified stack")
    parameters = normalized_parameters(stacks[0].get("Parameters"))
    print(json.dumps({
        "ok": True,
        "schemaVersion": SCHEMA,
        "parameterCount": len(parameters),
        "parametersSha256": sha256_bytes(canonical_json(parameters)),
        "stackIdSha256": sha256_bytes(stacks[0]["StackId"].encode("utf-8")),
        "rawParameterValuesPersisted": False,
    }, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
