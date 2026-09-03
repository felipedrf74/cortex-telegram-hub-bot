"""
YouTube video search via YouTube Data API v3. Synthetic results are available
only in explicit fixture mode; missing credentials never fabricate evidence.

Free tier: 10,000 quota units/day.  A search.list call costs 100 units,
so ~100 searches/day on the free tier.
"""

import hashlib
import logging
from datetime import datetime

import httpx

from config import cfg
from models.research import SearchResult
from searchers.base import ResearchSourceUnavailable, resolve_search_locale
from searchers.mock_fixtures import is_evergreen_mock_query, mock_search_result, query_slug

logger = logging.getLogger("content-engine.youtube")

YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"


def _query_fingerprint(query: str) -> str:
    return hashlib.sha256(query.encode("utf-8")).hexdigest()[:12]


def _raise_sanitized_youtube_status(resp: httpx.Response, query: str, stage: str) -> None:
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError:
        logger.warning(
            "YouTube API request failed (stage=%s status=%d query_hash=%s query_len=%d)",
            stage,
            resp.status_code,
            _query_fingerprint(query),
            len(query),
        )
        raise RuntimeError(f"YouTube API request failed with status {resp.status_code}") from None


class YouTubeSearcher:
    name = "youtube"

    async def search(
        self,
        query: str,
        max_results: int = 5,
        language: str | None = None,
    ) -> list[SearchResult]:
        if getattr(cfg, "fixture_mode", False):
            logger.debug("Content-engine fixture mode — returning synthetic YouTube results")
            return self._mock(query, max_results)
        if getattr(cfg, "research_network_disabled", False):
            logger.info("YouTube search disabled for this isolated runtime")
            raise ResearchSourceUnavailable(self.name, "network_disabled")
        if not cfg.youtube_api_key:
            logger.info("YouTube search unavailable because YOUTUBE_API_KEY is not configured")
            raise ResearchSourceUnavailable(self.name, "credentials_missing")

        async with httpx.AsyncClient(timeout=cfg.searcher_timeout) as client:
            # Step 1 — search for video IDs
            language_code, region_code = resolve_search_locale(language)
            search_params: dict[str, str | int] = {
                "part": "snippet",
                "q": query,
                "type": "video",
                "maxResults": max_results,
                "order": "relevance",
                "key": cfg.youtube_api_key,
            }
            if language_code:
                search_params["relevanceLanguage"] = language_code
            if region_code:
                search_params["regionCode"] = region_code
            resp = await client.get(YT_SEARCH_URL, params=search_params)
            _raise_sanitized_youtube_status(resp, query, "search")
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
            _raise_sanitized_youtube_status(stats_resp, query, "stats")
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

        logger.info(
            "YouTube API returned %d results (query_hash=%s query_len=%d)",
            len(results),
            _query_fingerprint(query),
            len(query),
        )
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
