"""
AI client for all creative/intelligence modules.

ARCHITECTURE (April 2026):
  This module NO LONGER calls Anthropic directly. All AI completions
  route through the TS backend's internal proxy endpoint:

    POST /api/v1/internal/ai-complete

  The TS backend handles:
    1. Provider cascade: Gemini → OpenAI → Anthropic (if enabled)
    2. Usage metering (api_usage + usage_metering tables)
    3. Telemetry events
    4. Kill switch enforcement

  This means Python never needs API keys for AI providers — it only
  needs INTERNAL_API_SECRET to talk to the TS backend.

  The module name is kept as `claude_client.py` for backward compat
  with all importers. The public API (ask_claude, ask_claude_json)
  is unchanged — callers don't need to update.
"""

import json
import logging
import os
import re
from contextvars import ContextVar
from typing import Any

import httpx

logger = logging.getLogger("content-engine.claude")

# Legacy model constants — kept for callers that pass model= explicitly.
# These are ignored now (TS picks the provider) but prevent import errors.
MODEL = "sonnet"
FAST_MODEL = "haiku"

# ── TS backend proxy ────────────────────────────────────────────────

_TS_BASE = (
    os.environ.get("NEXUS_BACKEND_BASE_URL")
    or os.environ.get("TS_BACKEND_BASE_URL")
    or f"http://localhost:{os.environ.get('NEXUS_BACKEND_PORT') or os.environ.get('TS_BACKEND_PORT') or '8200'}"
).rstrip("/")
_INTERNAL_SECRET = os.environ.get("INTERNAL_API_SECRET", "")
_AI_COMPLETE_URL = f"{_TS_BASE}/api/v1/internal/ai-complete"
_FIXTURE_MODE = (
    os.environ.get("CONTENT_ENGINE_FIXTURE_MODE") == "1"
    or os.environ.get("NEXUS_LOCAL_ALLOW_MODEL_CALLS") == "0"
)
_ATTRIBUTION_CONTEXT: ContextVar[dict[str, Any] | None] = ContextVar(
    "content_engine_attribution_context",
    default=None,
)


def set_attribution_context(
    user_id: int | None = None,
    tenant_id: int | None = None,
    attribution_token: str | None = None,
):
    """Install request-scoped user/tenant attribution for downstream AI calls."""
    return _ATTRIBUTION_CONTEXT.set({
        "user_id": user_id,
        "tenant_id": tenant_id,
        "attribution_token": attribution_token,
    })


def reset_attribution_context(token) -> None:
    _ATTRIBUTION_CONTEXT.reset(token)


def _strip_markdown_json_fence(raw: str) -> str:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json|JSON)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    return cleaned.strip()


def _extract_json_candidate(raw: str) -> str:
    cleaned = _strip_markdown_json_fence(raw)
    if not cleaned:
        return cleaned

    start_candidates = [idx for idx in (cleaned.find("{"), cleaned.find("[")) if idx >= 0]
    if not start_candidates:
        return cleaned
    start = min(start_candidates)
    opener = cleaned[start]
    closer = "}" if opener == "{" else "]"

    depth = 0
    in_string = False
    escaped = False
    for idx in range(start, len(cleaned)):
        ch = cleaned[idx]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return cleaned[start:idx + 1].strip()

    return cleaned[start:].strip()


async def _repair_json_response(
    raw: str,
    system: str,
    category: str,
    max_tokens: int,
    user_id: int | None = None,
    tenant_id: int | None = None,
) -> dict | list | None:
    repair_prompt = f"""Repair the following model output into valid JSON only.
Preserve the original structure and data. Do not summarize. Do not add markdown.
If a string contains a line break, escape it correctly. Return only the JSON object or array.

BROKEN OUTPUT:
{raw[:12000]}"""
    try:
        repaired = await ask_claude(
            repair_prompt,
            system=system,
            max_tokens=min(max_tokens, 4096),
            temperature=0.0,
            category=f"{category}_json_repair",
            json_mode=True,
            user_id=user_id,
            tenant_id=tenant_id,
        )
        return json.loads(_extract_json_candidate(repaired))
    except Exception as exc:
        logger.warning("AI JSON repair failed for category=%s: %s", category, exc)
        return None


async def ask_claude(
    prompt: str,
    system: str = "",
    model: str = FAST_MODEL,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    category: str = "content_engine",
    json_mode: bool = False,
    user_id: int | None = None,
    tenant_id: int | None = None,
    attribution_token: str | None = None,
) -> str:
    """Send a prompt through the TS AI proxy and return the text response.

    Routes through Gemini → OpenAI → Anthropic cascade on the TS side.
    The `model` parameter is kept for backward compat but is ignored —
    the TS backend picks the best available provider.
    """
    if _FIXTURE_MODE:
        raise RuntimeError("AI proxy disabled by Content Engine fixture mode.")

    if not _INTERNAL_SECRET:
        raise RuntimeError(
            "INTERNAL_API_SECRET not set — content-engine requires it to "
            "communicate with the TS backend's AI proxy."
        )

    context = _ATTRIBUTION_CONTEXT.get() or {}
    effective_user_id = user_id if user_id is not None else context.get("user_id")
    effective_tenant_id = tenant_id if tenant_id is not None else context.get("tenant_id")
    effective_attribution_token = attribution_token or context.get("attribution_token")

    body = {
        "prompt": prompt,
        "system": system,
        "category": category,
        "maxTokens": max_tokens,
        "temperature": temperature,
        "jsonMode": json_mode,
    }
    if effective_user_id is not None:
        body["userId"] = effective_user_id
    if effective_tenant_id is not None:
        body["tenantId"] = effective_tenant_id
    if effective_attribution_token:
        body["attributionToken"] = effective_attribution_token

    async with httpx.AsyncClient(timeout=300.0) as client:
        try:
            resp = await client.post(_AI_COMPLETE_URL, json=body, headers={
                "x-internal-secret": _INTERNAL_SECRET,
                "content-type": "application/json",
            })
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error(
                "AI proxy HTTP error %d for category=%s (%d chars)",
                e.response.status_code,
                category,
                len(e.response.text or ""),
            )
            raise RuntimeError(f"AI proxy error {e.response.status_code} for category={category}")
        except httpx.TimeoutException:
            logger.error("AI proxy timeout after 300s for category=%s", category)
            raise

        data = resp.json()

    text = data.get("text", "")
    provider = data.get("provider", "unknown")
    logger.info("AI complete via %s for category=%s (%d chars)", provider, category, len(text))

    if not text:
        logger.warning("AI proxy returned empty text for category=%s", category)

    return text


async def ask_claude_json(
    prompt: str,
    system: str = "",
    model: str = FAST_MODEL,
    max_tokens: int = 4096,
    temperature: float = 0.5,
    category: str = "content_engine",
    user_id: int | None = None,
    tenant_id: int | None = None,
    attribution_token: str | None = None,
) -> dict | list:
    """Send a prompt through the AI proxy and parse the response as JSON.

    The prompt should instruct the model to respond with valid JSON only.
    The proxy adds a JSON instruction suffix automatically when jsonMode
    could be used, but we also handle it here for robustness.
    """
    raw = await ask_claude(
        prompt, system=system, model=model,
        max_tokens=max_tokens, temperature=temperature,
        category=category, json_mode=True,
        user_id=user_id, tenant_id=tenant_id,
        attribution_token=attribution_token,
    )

    cleaned = _extract_json_candidate(raw)

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        repaired = await _repair_json_response(raw, system, category, max_tokens, user_id, tenant_id)
        if repaired is not None:
            logger.info("AI JSON response repaired for category=%s", category)
            return repaired

        logger.warning("AI proxy returned non-JSON after repair attempt for category=%s (%d chars)", category, len(raw))
        return {"raw": raw}
