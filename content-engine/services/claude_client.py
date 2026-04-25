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


async def ask_claude(
    prompt: str,
    system: str = "",
    model: str = FAST_MODEL,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    category: str = "content_engine",
    json_mode: bool = False,
) -> str:
    """Send a prompt through the TS AI proxy and return the text response.

    Routes through Gemini → OpenAI → Anthropic cascade on the TS side.
    The `model` parameter is kept for backward compat but is ignored —
    the TS backend picks the best available provider.
    """
    if not _INTERNAL_SECRET:
        raise RuntimeError(
            "INTERNAL_API_SECRET not set — content-engine requires it to "
            "communicate with the TS backend's AI proxy."
        )

    body = {
        "prompt": prompt,
        "system": system,
        "category": category,
        "maxTokens": max_tokens,
        "temperature": temperature,
        "jsonMode": json_mode,
    }

    async with httpx.AsyncClient(timeout=300.0) as client:
        try:
            resp = await client.post(_AI_COMPLETE_URL, json=body, headers={
                "x-internal-secret": _INTERNAL_SECRET,
                "content-type": "application/json",
            })
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error(
                "AI proxy HTTP error %d: %s",
                e.response.status_code,
                e.response.text[:300],
            )
            raise RuntimeError(f"AI proxy error {e.response.status_code}: {e.response.text[:200]}")
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
    )

    # Strip markdown code fences if present
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        cleaned = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        logger.warning("AI proxy returned non-JSON: %s", raw[:200])
        return {"raw": raw}
