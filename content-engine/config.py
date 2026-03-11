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

    # ── Timeouts (seconds) ────────────────────────────────────────────
    searcher_timeout: float = 10.0
    pipeline_timeout: float = 30.0

    # ── Scoring weights ───────────────────────────────────────────────
    weight_relevance: float = 0.40
    weight_virality: float = 0.30
    weight_recency: float = 0.30

    # ── Niche defaults ────────────────────────────────────────────────
    default_niches: list[str] = field(default_factory=lambda: [
        "fitness strength training gym trends",
        "running cycling endurance sports",
        "politics news trending debates Brazil",
        "viral reaction content YouTube trends",
        "self development motivational content",
    ])

    # ── Competitor channels (YouTube channel IDs or handles) ──────────
    niche1_competitors: list[str] = field(default_factory=lambda: [
        # Hybrid athlete / fitness PT-BR channels — add yours here
    ])
    niche2_competitors: list[str] = field(default_factory=lambda: [
        # Commentary / reaction PT-BR channels — add yours here
    ])


def load_config() -> EngineConfig:
    """Build config from environment variables."""
    return EngineConfig(
        serpapi_key=os.environ.get("SERPAPI_API_KEY", ""),
        youtube_api_key=os.environ.get("YOUTUBE_API_KEY", ""),
        newsapi_key=os.environ.get("NEWSAPI_API_KEY", ""),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        reddit_client_id=os.environ.get("REDDIT_CLIENT_ID", ""),
        reddit_client_secret=os.environ.get("REDDIT_CLIENT_SECRET", ""),
    )


# Singleton — import this everywhere
cfg = load_config()
