"""Per-request creator context helpers for content-engine prompt builders.

The content engine must not import the founder's saved profile at module load.
Callers should send the authenticated creator profile for each request. When a
profile is temporarily unavailable, prompts fall back to a neutral creator-safe
block instead of founder-shaped assumptions.
"""

from typing import Any


def _attr(source: Any, name: str, default: str | None = None) -> str | None:
    value = getattr(source, name, default)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return default


def creator_profile_block(source: Any | None = None) -> str:
    creator_profile = _attr(source, "creator_profile")
    if creator_profile:
        return f"AUTHENTICATED CREATOR PROFILE:\n{creator_profile[:6000]}"

    brand_voice = _attr(source, "brand_voice")
    if brand_voice:
        return f"AUTHENTICATED CREATOR BRAND VOICE:\n{brand_voice[:2000]}"

    return (
        "AUTHENTICATED CREATOR PROFILE:\n"
        "- No creator profile was supplied with this request.\n"
        "- Keep the output topic-driven, neutral, and scoped to the request.\n"
        "- Do not assume a default language, demographic, ideology, belief system, diet, nationality, or founder persona."
    )


def creator_language(source: Any | None = None) -> str:
    return _attr(source, "language", "en-US") or "en-US"


def language_instruction(source: Any | None = None) -> str:
    language = creator_language(source)
    return f"Use this requested output language unless the creator profile says otherwise: {language}."
