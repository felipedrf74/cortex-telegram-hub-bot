import re
from typing import Literal, Protocol, runtime_checkable
from models.research import SearchResult


ResearchSourceUnavailableReason = Literal["network_disabled", "credentials_missing"]


class ResearchSourceUnavailable(RuntimeError):
    """Categorical, payload-free signal that a configured source could not run."""

    def __init__(self, source: str, reason: ResearchSourceUnavailableReason):
        self.source = source
        self.reason = reason
        super().__init__(f"{source} research source unavailable ({reason})")


def resolve_search_locale(language: str | None) -> tuple[str | None, str | None]:
    """Return safe ISO-like language and region hints for search providers."""
    normalized = (language or "").strip().replace("_", "-").lower()
    match = re.fullmatch(r"([a-z]{2})(?:-([a-z]{2}))?", normalized)
    if not match:
        return None, None
    language_code, region_code = match.groups()
    return language_code, region_code.upper() if region_code else None


@runtime_checkable
class Searcher(Protocol):
    """Interface every searcher must implement.

    Adding a new source (Reddit, TikTok, etc.) = create a new file that
    satisfies this protocol. Zero changes to the orchestrator.
    """

    name: str  # e.g. "web", "youtube", "news"

    async def search(
        self,
        query: str,
        max_results: int = 5,
        language: str | None = None,
    ) -> list[SearchResult]:
        """Run a search and return normalized results."""
        ...
