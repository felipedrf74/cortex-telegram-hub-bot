"""
YouTube video search via YouTube Data API v3.
Falls back to mock data when YOUTUBE_API_KEY is empty.

Free tier: 10,000 quota units/day.  A search.list call costs 100 units,
so ~100 searches/day on the free tier.
"""

import logging
from datetime import datetime

import httpx

from config import cfg
from models.research import SearchResult
from searchers.mock_fixtures import is_evergreen_mock_query, mock_search_result, query_slug

logger = logging.getLogger("content-engine.youtube")

YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"

class YouTubeSearcher:
    name = "youtube"

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        if not cfg.youtube_api_key:
            logger.debug("No YOUTUBE_API_KEY — returning mock results")
            return self._mock(query, max_results)

        async with httpx.AsyncClient(timeout=cfg.searcher_timeout) as client:
            # Step 1 — search for video IDs
            search_params = {
                "part": "snippet",
                "q": query,
                "type": "video",
                "maxResults": max_results,
                "order": "relevance",
                "relevanceLanguage": "pt",
                "key": cfg.youtube_api_key,
            }
            resp = await client.get(YT_SEARCH_URL, params=search_params)
            resp.raise_for_status()
            search_data = resp.json()

            video_ids = [
                item["id"]["videoId"]
                for item in search_data.get("items", [])
                if item.get("id", {}).get("videoId")
            ]

            if not video_ids:
                return []

            # Step 2 — fetch statistics for those videos
            stats_params = {
                "part": "statistics,contentDetails",
                "id": ",".join(video_ids),
                "key": cfg.youtube_api_key,
            }
            stats_resp = await client.get(YT_VIDEOS_URL, params=stats_params)
            stats_resp.raise_for_status()
            stats_map: dict[str, dict] = {}
            for v in stats_resp.json().get("items", []):
                stats_map[v["id"]] = {
                    "view_count": int(v.get("statistics", {}).get("viewCount", 0)),
                    "like_count": int(v.get("statistics", {}).get("likeCount", 0)),
                    "comment_count": int(v.get("statistics", {}).get("commentCount", 0)),
                    "duration": v.get("contentDetails", {}).get("duration", ""),
                }

        results: list[SearchResult] = []
        for item in search_data.get("items", []):
            vid = item["id"].get("videoId", "")
            snippet = item.get("snippet", {})
            published = None
            if snippet.get("publishedAt"):
                try:
                    published = datetime.fromisoformat(snippet["publishedAt"].replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass

            meta = stats_map.get(vid, {})
            meta["channel_title"] = snippet.get("channelTitle", "")
            meta["channel_id"] = snippet.get("channelId", "")

            results.append(SearchResult(
                title=snippet.get("title", ""),
                url=f"https://www.youtube.com/watch?v={vid}",
                snippet=snippet.get("description", ""),
                source=self.name,
                published_at=published,
                thumbnail_url=(snippet.get("thumbnails", {}).get("high", {}) or {}).get("url"),
                metadata=meta,
            ))

        logger.info("YouTube API returned %d results for '%s'", len(results), query[:60])
        return results

    # ── fallback ──────────────────────────────────────────────────────
    @staticmethod
    def _mock(query: str, max_results: int) -> list[SearchResult]:
        video_slug = query_slug(query, separator="_", max_chars=20)
        walk_slug = query_slug(query, separator="_", max_chars=15)
        if is_evergreen_mock_query(query):
            return [
                mock_search_result(
                    query=query,
                    title=f"[Mock] Coach breakdown: {query}",
                    url=f"https://youtube.com/watch?v=mock_{video_slug}",
                    snippet=f"Mock coaching-style YouTube result for '{query}'. Set YOUTUBE_API_KEY for real results.",
                    source="youtube",
                    hours_ago=4,
                    metadata={"view_count": 42_000, "like_count": 1_200, "channel_title": "MockCoach"},
                ),
                mock_search_result(
                    query=query,
                    title=f"[Mock] {query} — practical walkthrough",
                    url=f"https://youtube.com/watch?v=mock_walk_{walk_slug}",
                    snippet=f"Mock practical walkthrough for {query}.",
                    source="youtube",
                    hours_ago=12,
                    metadata={"view_count": 58_000, "like_count": 2_400, "channel_title": "TrainingMock"},
                ),
            ][:max_results]
        return [
            mock_search_result(
                query=query,
                title=f"[Mock] {query} — YouTube deep dive",
                url=f"https://youtube.com/watch?v=mock_{video_slug}",
                snippet=f"Mock YouTube result for '{query}'. Set YOUTUBE_API_KEY for real results.",
                source="youtube",
                hours_ago=4,
                metadata={"view_count": 42_000, "like_count": 1_200, "channel_title": "MockChannel"},
            ),
            mock_search_result(
                query=query,
                title=f"[Mock] {query} reaction — INSANE",
                url=f"https://youtube.com/watch?v=mock_react_{walk_slug}",
                snippet=f"Reacting to {query} — this is wild.",
                source="youtube",
                hours_ago=12,
                metadata={"view_count": 128_000, "like_count": 5_600, "channel_title": "ReactionMock"},
            ),
        ][:max_results]
