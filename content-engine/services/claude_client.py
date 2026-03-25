"""
Shared Anthropic Claude API client for all creative/intelligence modules.

Uses httpx directly (no SDK dependency) to keep requirements lean.
All calls use claude-3-5-haiku for speed + cost efficiency on structured generation.
"""

import json
import logging

import httpx

from config import cfg

logger = logging.getLogger("content-engine.claude")

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-4-6"
FAST_MODEL = "claude-haiku-4-5-20251001"  # fast + cost-efficient for structured generation


async def ask_claude(
    prompt: str,
    system: str = "",
    model: str = FAST_MODEL,
    max_tokens: int = 4096,
    temperature: float = 0.7,
) -> str:
    """Send a single prompt to Claude and return the text response."""
    if not cfg.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set — creative modules require it")

    messages = [{"role": "user", "content": prompt}]
    body: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
        "temperature": temperature,
    }
    if system:
        body["system"] = system

    headers = {
        "x-api-key": cfg.anthropic_api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    async with httpx.AsyncClient(timeout=300.0) as client:
        try:
            resp = await client.post(ANTHROPIC_URL, json=body, headers=headers)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error("Claude API HTTP error %d: %s", e.response.status_code, e.response.text[:300])
            raise
        except httpx.TimeoutException:
            logger.error("Claude API timeout after 300s for model=%s max_tokens=%d", model, max_tokens)
            raise
        data = resp.json()

    # Extract text from first content block
    content_blocks = data.get("content", [])
    text_parts = [b["text"] for b in content_blocks if b.get("type") == "text"]
    if not text_parts:
        logger.warning("Claude returned no text blocks: %s", str(data)[:300])
    return "\n".join(text_parts)


async def ask_claude_json(
    prompt: str,
    system: str = "",
    model: str = FAST_MODEL,
    max_tokens: int = 4096,
    temperature: float = 0.5,
) -> dict | list:
    """Ask Claude and parse the response as JSON.

    The prompt should instruct Claude to respond with valid JSON only.
    """
    raw = await ask_claude(prompt, system=system, model=model,
                           max_tokens=max_tokens, temperature=temperature)

    # Strip markdown code fences if present
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        # Remove first and last lines (```json and ```)
        lines = cleaned.split("\n")
        cleaned = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        logger.warning("Claude returned non-JSON: %s", raw[:200])
        return {"raw": raw}
