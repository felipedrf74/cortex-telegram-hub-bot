"""
Legacy creator-profile compatibility loader.

CENTRALIZATION (April 2026):
  The canonical source is `prompts/creator-config.md` in the repository root.
  This module reads that file at startup instead of maintaining a duplicate.
  If the file is not found (e.g. during isolated testing), it falls back to
  a NEUTRAL profile with NO hardcoded identity.

  Current creative endpoints receive authenticated request-scoped creator
  context directly and do not use this module as their identity authority.
  Keep this loader neutral for dormant/legacy callers; do not reintroduce it
  as a global fallback for request-time generation.

  DO NOT add specific creator identity, founder name, owner persona,
  worldview, or audience profile here. Real creator identity is loaded
  per-request from the authenticated user's saved Voice DNA / creator
  profile rows (see content-creative-memory and tenant-scoped services).

  Edit `prompts/creator-config.md` — both TS and Python read from it.
"""

import os
import logging

from services.log_safety import safe_error_type

logger = logging.getLogger("content-engine.profile")

# ── Locate the canonical config file ────────────────────────────────

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_CONFIG_PATH = os.path.join(_REPO_ROOT, "prompts", "creator-config.md")

# ── Identity-safety fallback (May 2026 audit) ────────────────────────
# If creator-config.md is unreachable, we MUST NOT substitute a specific
# founder identity. The fallback below is intentionally neutral — no name,
# no worldview, no audience. Callers that need real creator identity must
# load it per-request from the authenticated user's tenant-scoped row.
_FALLBACK_PROFILE = """CREATOR PROFILE: NOT YET CONFIGURED FOR THIS USER
The authenticated creator's saved Voice DNA, audience, references, and
brand voice were not available at request time. Generate setup-safe,
neutral output OR ask for the missing creator setup; do not assume a
founder, owner, or default creator identity."""

_FALLBACK_SHORT = """Creator profile not configured for this user. Stay neutral; do not assume founder/owner/default identity."""


def _load_config() -> str:
    """Load the canonical creator config from prompts/creator-config.md."""
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            content = f.read().strip()
        logger.info("Loaded neutral legacy creator config (%d chars)", len(content))
        return content
    except FileNotFoundError:
        logger.warning("Legacy creator config not found — using neutral fallback")
        return _FALLBACK_PROFILE
    except Exception as exc:
        logger.error(
            "Failed to load creator config (error_type=%s) — using neutral fallback",
            safe_error_type(exc),
        )
        return _FALLBACK_PROFILE


# Load once at import time
CREATOR_PROFILE = _load_config()

# Short profile: first 3 non-empty lines of the config, or fallback
_lines = [l.strip() for l in CREATOR_PROFILE.split("\n") if l.strip() and not l.startswith("━")]
CREATOR_PROFILE_SHORT = "\n".join(_lines[:5]) if len(_lines) >= 5 else _FALLBACK_SHORT


def get_profile(short: bool = False) -> str:
    """Return the creator profile for prompt injection."""
    return CREATOR_PROFILE_SHORT if short else CREATOR_PROFILE
