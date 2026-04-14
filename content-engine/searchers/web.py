"""
Web search via SerpAPI.  Falls back to mock data when SERPAPI_API_KEY is empty.

SerpAPI returns Google results as structured JSON — no scraping needed.
Free tier: 100 searches/month.
"""

import logging
from datetime import datetime, timedelta, timezone

import httpx

from config import cfg
from models.research import SearchResult

logger = logging.getLogger("content-engine.web")

SERPAPI_ENDPOINT = "https://serpapi.com/search.json"

EVERGREEN_MOCK_HINTS = (
    "recovery", "recover", "interval", "training", "workout", "sleep", "hydration",
    "protein", "nutrition", "guide", "evidence", "study", "protocol", "hill repeat",
    "recuperação", "recuperar", "intervalos", "repetições", "treino", "sono", "hidratação", "proteína",
    "nutrição", "guia", "evidência", "estudo", "protocolo", "desaquecimento", "subida",
)


class WebSearcher:
    name = "web"

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        if not cfg.serpapi_key:
            logger.debug("No SERPAPI_API_KEY — returning mock results")
            return self._mock(query, max_results)

        params = {
            "q": query,
            "api_key": cfg.serpapi_key,
            "num": max_results,
            "hl": "pt",
            "gl": "br",
        }
        async with httpx.AsyncClient(timeout=cfg.searcher_timeout) as client:
            resp = await client.get(SERPAPI_ENDPOINT, params=params)
            resp.raise_for_status()
            data = resp.json()

        results: list[SearchResult] = []
        for item in data.get("organic_results", [])[:max_results]:
            published = None
            if item.get("date"):
                try:
                    published = datetime.fromisoformat(item["date"])
                except (ValueError, TypeError):
                    pass

            results.append(SearchResult(
                title=item.get("title", ""),
                url=item.get("link", ""),
                snippet=item.get("snippet", ""),
                source=self.name,
                published_at=published,
                thumbnail_url=item.get("thumbnail"),
                metadata={"position": item.get("position"), "displayed_link": item.get("displayed_link")},
            ))

        logger.info("SerpAPI returned %d results for '%s'", len(results), query[:60])
        return results

    # ── fallback when no key ──────────────────────────────────────────
    @staticmethod
    def _mock(query: str, max_results: int) -> list[SearchResult]:
        now = datetime.now(timezone.utc)
        lower = query.lower()
        if any(hint in lower for hint in EVERGREEN_MOCK_HINTS):
            return [
                SearchResult(
                    title=f"[Mock] {query} — evidence overview",
                    url=f"https://example.com/web/{query.replace(' ', '-')}",
                    snippet=f"Mock evidence-style web result for '{query}'. Set SERPAPI_API_KEY to get real results.",
                    source="web",
                    published_at=now - timedelta(hours=2),
                ),
                SearchResult(
                    title=f"[Mock] Practical guide to {query}",
                    url=f"https://example.com/web/guide-{query.replace(' ', '-')}",
                    snippet=f"Mock practical guide for '{query}' with protocol-style takeaways.",
                    source="web",
                    published_at=now - timedelta(hours=6),
                ),
            ][:max_results]
        return [
            SearchResult(
                title=f"[Mock] {query} — trending analysis",
                url=f"https://example.com/web/{query.replace(' ', '-')}",
                snippet=f"Mock web result for '{query}'. Set SERPAPI_API_KEY to get real results.",
                source="web",
                published_at=now - timedelta(hours=2),
            ),
            SearchResult(
                title=f"[Mock] Why {query} is going viral",
                url=f"https://example.com/web/viral-{query.replace(' ', '-')}",
                snippet=f"Everyone is talking about {query} today — here's why.",
                source="web",
                published_at=now - timedelta(hours=6),
            ),
        ][:max_results]
