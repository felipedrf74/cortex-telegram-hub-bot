"""
Web search via SerpAPI.  Falls back to mock data when SERPAPI_API_KEY is empty.

SerpAPI returns Google results as structured JSON — no scraping needed.
Free tier: 100 searches/month.
"""

import hashlib
import logging
from datetime import datetime

import httpx

from config import cfg
from models.research import SearchResult
from searchers.mock_fixtures import is_evergreen_mock_query, mock_search_result, query_slug

logger = logging.getLogger("content-engine.web")

SERPAPI_ENDPOINT = "https://serpapi.com/search.json"


def _query_fingerprint(query: str) -> str:
    return hashlib.sha256(query.encode("utf-8")).hexdigest()[:12]


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
            try:
                resp.raise_for_status()
            except httpx.HTTPStatusError:
                logger.warning(
                    "SerpAPI request failed (status=%d query_hash=%s query_len=%d)",
                    resp.status_code,
                    _query_fingerprint(query),
                    len(query),
                )
                raise RuntimeError(f"SerpAPI request failed with status {resp.status_code}") from None
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

        logger.info(
            "SerpAPI returned %d results (query_hash=%s query_len=%d)",
            len(results),
            _query_fingerprint(query),
            len(query),
        )
        return results

    # ── fallback when no key ──────────────────────────────────────────
    @staticmethod
    def _mock(query: str, max_results: int) -> list[SearchResult]:
        slug = query_slug(query)
        if is_evergreen_mock_query(query):
            return [
                mock_search_result(
                    query=query,
                    title=f"[Mock] {query} — evidence overview",
                    url=f"https://example.com/web/{slug}",
                    snippet=f"Mock evidence-style web result for '{query}'. Set SERPAPI_API_KEY to get real results.",
                    source="web",
                    hours_ago=2,
                ),
                mock_search_result(
                    query=query,
                    title=f"[Mock] Practical guide to {query}",
                    url=f"https://example.com/web/guide-{slug}",
                    snippet=f"Mock practical guide for '{query}' with protocol-style takeaways.",
                    source="web",
                    hours_ago=6,
                ),
            ][:max_results]
        return [
            mock_search_result(
                query=query,
                title=f"[Mock] {query} — trending analysis",
                url=f"https://example.com/web/{slug}",
                snippet=f"Mock web result for '{query}'. Set SERPAPI_API_KEY to get real results.",
                source="web",
                hours_ago=2,
            ),
            mock_search_result(
                query=query,
                title=f"[Mock] Why {query} is going viral",
                url=f"https://example.com/web/viral-{slug}",
                snippet=f"Everyone is talking about {query} today — here's why.",
                source="web",
                hours_ago=6,
            ),
        ][:max_results]
