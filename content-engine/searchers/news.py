"""
News search via NewsAPI.org. Synthetic results are available only in explicit
fixture mode; missing credentials never fabricate evidence.

Free tier: 100 requests/day, developer use only (no production caching).
Searches across 80 000+ sources worldwide, filterable by language.
"""

import hashlib
import logging
from datetime import datetime, timedelta, timezone

import httpx

from config import cfg
from models.research import SearchResult
from searchers.base import ResearchSourceUnavailable, resolve_search_locale
from searchers.mock_fixtures import is_evergreen_mock_query, mock_search_result, query_slug

logger = logging.getLogger("content-engine.news")

NEWSAPI_ENDPOINT = "https://newsapi.org/v2/everything"


def _query_fingerprint(query: str) -> str:
    return hashlib.sha256(query.encode("utf-8")).hexdigest()[:12]


class NewsSearcher:
    name = "news"

    async def search(
        self,
        query: str,
        max_results: int = 5,
        language: str | None = None,
    ) -> list[SearchResult]:
        if getattr(cfg, "fixture_mode", False):
            logger.debug("Content-engine fixture mode — returning synthetic news results")
            return self._mock(query, max_results)
        if getattr(cfg, "research_network_disabled", False):
            logger.info("News search disabled for this isolated runtime")
            raise ResearchSourceUnavailable(self.name, "network_disabled")
        if not cfg.newsapi_key:
            logger.info("News search unavailable because NEWSAPI_API_KEY is not configured")
            raise ResearchSourceUnavailable(self.name, "credentials_missing")

        # Search the last 48 hours using the caller's locale when NewsAPI
        # supports that language. No creator locale is assumed when absent.
        from_date = (datetime.now(timezone.utc) - timedelta(hours=48)).strftime("%Y-%m-%dT%H:%M:%S")
        language_code, _ = resolve_search_locale(language)
        params: dict[str, str | int] = {
            "q": query,
            "from": from_date,
            "sortBy": "publishedAt",
            "pageSize": max_results,
            "apiKey": cfg.newsapi_key,
        }
        if language_code in {"ar", "de", "en", "es", "fr", "he", "it", "nl", "no", "pt", "ru", "sv", "ud", "zh"}:
            params["language"] = language_code

        async with httpx.AsyncClient(timeout=cfg.searcher_timeout) as client:
            resp = await client.get(NEWSAPI_ENDPOINT, params=params)
            try:
                resp.raise_for_status()
            except httpx.HTTPStatusError:
                logger.warning(
                    "NewsAPI request failed (status=%d query_hash=%s query_len=%d)",
                    resp.status_code,
                    _query_fingerprint(query),
                    len(query),
                )
                raise RuntimeError(f"NewsAPI request failed with status {resp.status_code}") from None
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

        logger.info(
            "NewsAPI returned %d results (query_hash=%s query_len=%d)",
            len(results),
            _query_fingerprint(query),
            len(query),
        )
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
                title=f"[Mock] Breaking: {query} changes the conversation",
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
                snippet=f"Experts react to {query} and explain the wider implications.",
                source="news",
                hours_ago=3,
                metadata={"publisher": "Mock Herald", "category": "analysis"},
            ),
        ][:max_results]
