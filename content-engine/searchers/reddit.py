"""
Reddit search via public JSON API (no auth needed).

Appending `.json` to any Reddit URL returns structured JSON.
No rate limit issues at modest volumes (< 60 req/min).

Subreddits are pre-configured per niche for targeted discovery.
"""

import logging
from datetime import datetime, timezone

import httpx

from config import cfg
from models.research import SearchResult
from searchers.mock_fixtures import mock_search_result, query_slug

logger = logging.getLogger("content-engine.reddit")

# Niche-specific subreddits for targeted research
NICHE_SUBREDDITS = {
    "fitness": ["fitness", "running", "cycling", "triathlon", "AdvancedRunning"],
    "commentary": ["CreatorEconomy", "youtube", "socialmedia", "OutOfTheLoop"],
}
ALL_SUBREDDITS = [s for subs in NICHE_SUBREDDITS.values() for s in subs]

REDDIT_SEARCH_URL = "https://www.reddit.com/search.json"
REDDIT_HEADERS = {"User-Agent": "CortexBot/1.0 (content research)"}


class RedditSearcher:
    name = "reddit"

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        if cfg.fixture_mode:
            logger.debug("Content-engine fixture mode — returning mock Reddit results")
            return self._mock(query, max_results)

        params = {
            "q": query,
            "sort": "relevance",
            "t": "week",          # last 7 days
            "limit": max_results,
            "type": "link",
        }

        try:
            async with httpx.AsyncClient(timeout=cfg.searcher_timeout, headers=REDDIT_HEADERS) as client:
                resp = await client.get(REDDIT_SEARCH_URL, params=params)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPError as exc:
            logger.warning("Reddit search failed: %s", exc)
            return []

        results: list[SearchResult] = []
        for child in data.get("data", {}).get("children", [])[:max_results]:
            post = child.get("data", {})
            created_utc = post.get("created_utc")
            published = datetime.fromtimestamp(created_utc, tz=timezone.utc) if created_utc else None

            score = post.get("score", 0)
            num_comments = post.get("num_comments", 0)
            thumbnail = post.get("thumbnail")

            results.append(SearchResult(
                title=post.get("title", ""),
                url=f"https://reddit.com{post.get('permalink', '')}",
                snippet=(post.get("selftext", "") or "")[:300],
                source=self.name,
                published_at=published,
                thumbnail_url=thumbnail if isinstance(thumbnail, str) and thumbnail.startswith("http") else None,
                metadata={
                    "subreddit": post.get("subreddit", ""),
                    "score": score,
                    "num_comments": num_comments,
                    "upvote_ratio": post.get("upvote_ratio", 0),
                    "is_hot": score > 500 or num_comments > 200,
                },
            ))

        logger.info("Reddit returned %d results for '%s'", len(results), query[:60])
        return results

    @staticmethod
    def _mock(query: str, max_results: int) -> list[SearchResult]:
        discussion_slug = query_slug(query, separator="_", max_chars=24)
        angle_slug = query_slug(query, separator="_", max_chars=18)
        return [
            mock_search_result(
                query=query,
                title=f"[Mock] Reddit discussion: {query}",
                url=f"https://reddit.com/r/mock/comments/{discussion_slug}",
                snippet=f"Mock Reddit discussion for '{query}'. Fixture mode avoids live Reddit calls.",
                source="reddit",
                hours_ago=5,
                metadata={
                    "subreddit": "mock",
                    "score": 180,
                    "num_comments": 42,
                    "upvote_ratio": 0.91,
                    "is_hot": False,
                },
            ),
            mock_search_result(
                query=query,
                title=f"[Mock] Creator angle from Reddit: {query}",
                url=f"https://reddit.com/r/mock/comments/angle_{angle_slug}",
                snippet=f"Mock audience language for '{query}' to support fixture-only research.",
                source="reddit",
                hours_ago=9,
                metadata={
                    "subreddit": "mockcreators",
                    "score": 96,
                    "num_comments": 18,
                    "upvote_ratio": 0.88,
                    "is_hot": False,
                },
            ),
        ][:max_results]
