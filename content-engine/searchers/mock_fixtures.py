from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from models.research import SearchResult


EVERGREEN_MOCK_HINTS = (
    "recovery", "recover", "interval", "training", "workout", "sleep", "hydration",
    "protein", "nutrition", "guide", "evidence", "study", "protocol", "hill repeat",
    "recuperação", "recuperar", "intervalos", "repetições", "treino", "sono", "hidratação", "proteína",
    "nutrição", "guia", "evidência", "estudo", "protocolo", "desaquecimento", "subida",
)


def is_evergreen_mock_query(query: str) -> bool:
    lower = query.lower()
    return any(hint in lower for hint in EVERGREEN_MOCK_HINTS)


def query_slug(query: str, *, separator: str = "-", max_chars: int | None = None) -> str:
    slug = query.replace(" ", separator)
    return slug[:max_chars] if max_chars is not None else slug


def mock_search_result(
    *,
    query: str,
    source: str,
    title: str,
    url: str,
    snippet: str,
    hours_ago: int,
    metadata: dict[str, Any] | None = None,
) -> SearchResult:
    return SearchResult(
        title=title,
        url=url,
        snippet=snippet,
        source=source,
        published_at=datetime.now(timezone.utc) - timedelta(hours=hours_ago),
        metadata={**(metadata or {}), "mock": True},
    )
