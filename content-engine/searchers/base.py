from typing import Protocol, runtime_checkable
from models.research import SearchResult


@runtime_checkable
class Searcher(Protocol):
    """Interface every searcher must implement.

    Adding a new source (Reddit, TikTok, etc.) = create a new file that
    satisfies this protocol. Zero changes to the orchestrator.
    """

    name: str  # e.g. "web", "youtube", "news"

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        """Run a search and return normalized results."""
        ...
