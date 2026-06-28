import logging
import re


_API_KEY_RE = re.compile(r"(?i)\b(api_key|apiKey|key)=([^&\s'\"<>]+)")
_BEARER_RE = re.compile(r"(?i)\bBearer\s+([A-Za-z0-9._~+/=-]+)")


def redact_log_message(message: str) -> str:
    redacted = _API_KEY_RE.sub(lambda match: f"{match.group(1)}=<redacted>", message)
    return _BEARER_RE.sub("Bearer <redacted>", redacted)


class SecretRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact_log_message(record.getMessage())
        record.args = ()
        return True
