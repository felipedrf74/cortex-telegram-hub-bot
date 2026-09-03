"""Small helpers for categorical logs at provider and tenant-data boundaries."""

import hashlib
import re


def input_fingerprint(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()[:12]


def safe_error_type(error: BaseException) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", type(error).__name__)[:80] or "Exception"
