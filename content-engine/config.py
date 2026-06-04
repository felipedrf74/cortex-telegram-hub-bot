"""
Centralised configuration — all API keys and tuning knobs in one place.

Keys are read from environment variables so the same .env that feeds the
TS bot can also feed the Python engine (just `source .env` before starting).
"""

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class EngineConfig:
    # ── API keys ──────────────────────────────────────────────────────
    serpapi_key: str = ""
    youtube_api_key: str = ""
    newsapi_key: str = ""
    anthropic_api_key: str = ""
    reddit_client_id: str = ""
    reddit_client_secret: str = ""
    internal_api_secret: str = ""
    fixture_mode: bool = False
    env: str = "development"

    # ── Timeouts (seconds) ────────────────────────────────────────────
    searcher_timeout: float = 10.0
    pipeline_timeout: float = 30.0

    # ── Competitor channels (YouTube channel IDs or handles) ──────────
    niche1_competitors: list[str] = field(default_factory=lambda: [
        # Hybrid athlete / fitness PT-BR channels — add yours here
    ])
    niche2_competitors: list[str] = field(default_factory=lambda: [
        # Commentary / reaction PT-BR channels — add yours here
    ])


def load_config() -> EngineConfig:
    """Build config from environment variables."""
    env = os.environ.get("ENV") or os.environ.get("NODE_ENV") or "development"
    internal_api_secret = os.environ.get("INTERNAL_API_SECRET", "")
    if _fixture_mode_enabled():
        return EngineConfig(
            fixture_mode=True,
            internal_api_secret=internal_api_secret,
            env=env,
        )

    if env == "production" and not internal_api_secret:
        raise RuntimeError(
            "INTERNAL_API_SECRET must be set before starting the content engine in production."
        )

    return EngineConfig(
        serpapi_key=os.environ.get("SERPAPI_API_KEY", ""),
        youtube_api_key=os.environ.get("YOUTUBE_API_KEY", ""),
        newsapi_key=os.environ.get("NEWSAPI_API_KEY", ""),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        reddit_client_id=os.environ.get("REDDIT_CLIENT_ID", ""),
        reddit_client_secret=os.environ.get("REDDIT_CLIENT_SECRET", ""),
        internal_api_secret=internal_api_secret,
        env=env,
    )


def _fixture_mode_enabled() -> bool:
    return (
        os.environ.get("CONTENT_ENGINE_FIXTURE_MODE") == "1"
        or os.environ.get("NEXUS_LOCAL_ALLOW_MODEL_CALLS") == "0"
    )


# Singleton — import this everywhere
cfg = load_config()
