"""
Felipe's creator profile — injected into all creative AI prompts.

CENTRALIZATION (April 2026):
  The canonical source is `prompts/creator-config.md` in the repository root.
  This module reads that file at startup instead of maintaining a duplicate.
  If the file is not found (e.g. during isolated testing), it falls back to
  a minimal hardcoded profile.

  DO NOT duplicate creator identity, voice, or config values here.
  Edit `prompts/creator-config.md` — both TS and Python read from it.
"""

import os
import logging

logger = logging.getLogger("content-engine.profile")

# ── Locate the canonical config file ────────────────────────────────

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_CONFIG_PATH = os.path.join(_REPO_ROOT, "prompts", "creator-config.md")

_FALLBACK_PROFILE = """CREATOR: Felipe Dominguez — "The Operator"
LANGUAGE: Portuguese (PT-BR), natural and conversational
AUDIENCE: Portuguese-speaking men 18-40 into tech, self-improvement, direct opinions.
Voice: direct, no-BS, Asmongold-style reactions. Austrian economics, anti-state.
NOTE: This is a fallback profile — prompts/creator-config.md was not found."""

_FALLBACK_SHORT = """Felipe Dominguez — "The Operator". Brazilian creator, conservative Christian libertarian.
Audience: men 18-40. Voice: direct, no-BS, PT-BR. (Fallback — creator-config.md not found.)"""


def _load_config() -> str:
    """Load the canonical creator config from prompts/creator-config.md."""
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            content = f.read().strip()
        logger.info("Loaded creator config from %s (%d chars)", _CONFIG_PATH, len(content))
        return content
    except FileNotFoundError:
        logger.warning("Creator config not found at %s — using fallback", _CONFIG_PATH)
        return _FALLBACK_PROFILE
    except Exception as e:
        logger.error("Failed to load creator config: %s — using fallback", e)
        return _FALLBACK_PROFILE


# Load once at import time
CREATOR_PROFILE = _load_config()

# Short profile: first 3 non-empty lines of the config, or fallback
_lines = [l.strip() for l in CREATOR_PROFILE.split("\n") if l.strip() and not l.startswith("━")]
CREATOR_PROFILE_SHORT = "\n".join(_lines[:5]) if len(_lines) >= 5 else _FALLBACK_SHORT


def get_profile(short: bool = False) -> str:
    """Return the creator profile for prompt injection."""
    return CREATOR_PROFILE_SHORT if short else CREATOR_PROFILE
