"""
News search via NewsAPI.org.  Falls back to mock data when NEWSAPI_API_KEY is empty.

Free tier: 100 requests/day, developer use only (no production caching).
Searches across 80 000+ sources worldwide, filterable by language.
"""

import logging
from datetime import datetime, timedelta, timezone

import httpx

from config import cfg
from models.research import SearchResult
from searchers.mock_fixtures import is_evergreen_mock_query, mock_search_result, query_slug

logger = logging.getLogger("content-engine.news")

NEWSAPI_ENDPOINT = "https://newsapi.org/v2/everything"

class NewsSearcher:
    name = "news"

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        if not cfg.newsapi_key:
            logger.debug("No NEWSAPI_API_KEY — returning mock results")
            return self._mock(query, max_results)

        # Search last 48 hours, Portuguese + English
        from_date = (datetime.now(timezone.utc) - timedelta(hours=48)).strftime("%Y-%m-%dT%H:%M:%S")
        params = {
            "q": query,
            "from": from_date,
            "sortBy": "publishedAt",
            "pageSize": max_results,
            "language": "pt",          # Portuguese first
            "apiKey": cfg.newsapi_key,
        }

        async with httpx.AsyncClient(timeout=cfg.searcher_timeout) as client:
            resp = await client.get(NEWSAPI_ENDPOINT, params=params)
            resp.raise_for_status()
            data = resp.json()

        results: list[SearchResult] = []
        for article in data.get("articles", [])[:max_results]:
            published = None
            if article.get("publishedAt"):
                try:
                    published = datetime.fromisoformat(article["publishedAt"].replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass

            results.append(SearchResult(
                title=article.get("title", "") or "",
                url=article.get("url", ""),
                snippet=article.get("description", "") or "",
                source=self.name,
                published_at=published,
                thumbnail_url=article.get("urlToImage"),
                metadata={
                    "publisher": (article.get("source") or {}).get("name", ""),
                    "author": article.get("author", ""),
                },
            ))

        logger.info("NewsAPI returned %d results for '%s'", len(results), query[:60])
        return results

    # ── fallback ──────────────────────────────────────────────────────
    @staticmethod
    def _mock(query: str, max_results: int) -> list[SearchResult]:
        slug = query_slug(query)
        if is_evergreen_mock_query(query):
            return [
                mock_search_result(
                    query=query,
                    title=f"[Mock] Experts on {query}: practical protocol",
                    url=f"https://example.com/news/{slug}",
                    snippet=f"Mock evidence-style news result for '{query}'. Set NEWSAPI_API_KEY for real results.",
                    source="news",
                    hours_ago=1,
                    metadata={"publisher": "Mock Health Desk", "category": "analysis"},
                ),
                mock_search_result(
                    query=query,
                    title=f"[Mock] {query}: evidence review",
                    url=f"https://example.com/news/experts-{slug}",
                    snippet=f"Mock expert review for {query} with practical takeaways.",
                    source="news",
                    hours_ago=3,
                    metadata={"publisher": "Mock Science Brief", "category": "analysis"},
                ),
            ][:max_results]
        return [
            mock_search_result(
                query=query,
                title=f"[Mock] Breaking: {query} shakes Brazil",
                url=f"https://example.com/news/{slug}",
                snippet=f"Mock news result for '{query}'. Set NEWSAPI_API_KEY for real results.",
                source="news",
                hours_ago=1,
                metadata={"publisher": "Mock News", "category": "politics"},
            ),
            mock_search_result(
                query=query,
                title=f"[Mock] {query}: experts weigh in",
                url=f"https://example.com/news/experts-{slug}",
                snippet=f"Experts react to {query} — implications for Brazil.",
                source="news",
                hours_ago=3,
                metadata={"publisher": "Mock Herald", "category": "analysis"},
            ),
        ][:max_results]
