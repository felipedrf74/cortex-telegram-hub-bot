import asyncio
import time
import logging
from models.research import SearchResult, TrendingTopic, ContentBrief
from models.requests import (
    DeepSearchResponse, SourcesResponse, HotNewsResponse,
    TrendingResponse, ReactionResponse,
)
from models.scoring import ScoredResult
from searchers.base import Searcher
from searchers.web import WebSearcher
from searchers.youtube import YouTubeSearcher
from searchers.news import NewsSearcher
from searchers.reddit import RedditSearcher
from .scorer import score_results
from .brief_builder import build_briefs
from datetime import datetime, timezone

logger = logging.getLogger("content-engine")

# Default content niches — same as the TS bot's CONTENT_NICHES
DEFAULT_NICHES = [
    "fitness strength training gym trends",
    "running cycling endurance sports",
    "politics news trending debates Brazil",
    "viral reaction content YouTube trends",
    "self development motivational content",
]


class ResearchOrchestrator:
    """Fans out queries to all searchers in parallel, scores, and builds briefs."""

    def __init__(self, searchers: list[Searcher] | None = None):
        self.searchers: list[Searcher] = searchers or [
            WebSearcher(),
            YouTubeSearcher(),
            NewsSearcher(),
            RedditSearcher(),
        ]

    async def _fan_out(self, query: str, max_per_searcher: int = 5) -> list[SearchResult]:
        """Run all searchers concurrently and merge results."""
        tasks = [s.search(query, max_per_searcher) for s in self.searchers]
        results_lists = await asyncio.gather(*tasks, return_exceptions=True)

        merged: list[SearchResult] = []
        for i, result in enumerate(results_lists):
            if isinstance(result, Exception):
                logger.warning("Searcher %s failed: %s", self.searchers[i].name, result)
                continue
            merged.extend(result)
        return merged

    async def _fan_out_specific(self, query: str, source_names: list[str], max_per: int = 5) -> list[SearchResult]:
        """Run only specific searchers by name."""
        selected = [s for s in self.searchers if s.name in source_names]
        tasks = [s.search(query, max_per) for s in selected]
        results_lists = await asyncio.gather(*tasks, return_exceptions=True)

        merged: list[SearchResult] = []
        for i, result in enumerate(results_lists):
            if isinstance(result, Exception):
                logger.warning("Searcher %s failed: %s", selected[i].name, result)
                continue
            merged.extend(result)
        return merged

    async def deep_search(self, query: str, niches: list[str] | None = None, max_results: int = 10) -> DeepSearchResponse:
        """Full research pipeline: fan-out → score → build briefs."""
        start = time.monotonic()
        search_niches = niches or DEFAULT_NICHES

        niche_tasks = [self._fan_out(f"{query} {niche}") for niche in search_niches]
        niche_results = await asyncio.gather(*niche_tasks, return_exceptions=True)

        all_results: list[SearchResult] = []
        for i, results in enumerate(niche_results):
            if isinstance(results, Exception):
                logger.warning("Niche fan-out failed for '%s': %s", search_niches[i], results)
                continue
            all_results.extend(results)

        search_count = len(search_niches) * len(self.searchers)
        scored = score_results(all_results)
        briefs = build_briefs(scored, max_briefs=max_results)

        duration_ms = int((time.monotonic() - start) * 1000)
        logger.info("deep_search completed: %d results → %d briefs in %dms", len(all_results), len(briefs), duration_ms)

        return DeepSearchResponse(
            query=query,
            briefs=briefs,
            search_count=search_count,
            duration_ms=duration_ms,
        )

    async def get_sources(self, query: str) -> SourcesResponse:
        """Curated source list for a topic — search all sources, deduplicate by URL."""
        results = await self._fan_out(query, max_per_searcher=5)
        scored = score_results(results)

        from models.research import SourceReference
        seen_urls: set[str] = set()
        sources: list[SourceReference] = []
        for item in scored:
            if item.result.url in seen_urls:
                continue
            seen_urls.add(item.result.url)
            sources.append(SourceReference(
                title=item.result.title,
                url=item.result.url,
                source_type=item.result.source,
                relevance_note=f"Score: {item.score.composite:.2f}",
            ))

        return SourcesResponse(query=query, sources=sources)

    async def hot_news(self) -> HotNewsResponse:
        """What's trending right now — search news across all niches."""
        niche_tasks = [self._fan_out(niche, max_per_searcher=3) for niche in DEFAULT_NICHES]
        niche_results = await asyncio.gather(*niche_tasks, return_exceptions=True)

        topics: list[TrendingTopic] = []
        for i, results in enumerate(niche_results):
            if isinstance(results, Exception):
                logger.warning("Hot news fan-out failed for '%s': %s", DEFAULT_NICHES[i], results)
                continue
            scored = score_results(results)
            for item in scored[:2]:
                topics.append(TrendingTopic(
                    topic=item.result.title.replace("[Mock] ", ""),
                    heat_score=item.score.composite,
                    sources=[item.result.source],
                    first_seen=item.result.published_at,
                    niche=DEFAULT_NICHES[i].split()[0],
                ))

        topics.sort(key=lambda t: t.heat_score, reverse=True)

        return HotNewsResponse(
            topics=topics,
            generated_at=datetime.now(timezone.utc).isoformat(),
        )

    async def trending(self, niche: str | None = None) -> TrendingResponse:
        """Cross-platform trending topics — faster than deep_search, no briefs."""
        start = time.monotonic()
        niches_to_search = [niche] if niche else DEFAULT_NICHES

        # Use all sources for max coverage
        niche_tasks = [self._fan_out(n, max_per_searcher=3) for n in niches_to_search]
        niche_results = await asyncio.gather(*niche_tasks, return_exceptions=True)

        all_results: list[SearchResult] = []
        for i, results in enumerate(niche_results):
            if isinstance(results, Exception):
                logger.warning("Trending fan-out failed: %s", results)
                continue
            all_results.extend(results)

        scored = score_results(all_results)

        # Deduplicate by URL, keep top N
        seen: set[str] = set()
        topics: list[TrendingTopic] = []
        for item in scored:
            if item.result.url in seen:
                continue
            seen.add(item.result.url)
            topics.append(TrendingTopic(
                topic=item.result.title.replace("[Mock] ", ""),
                heat_score=item.score.composite,
                sources=[item.result.source],
                first_seen=item.result.published_at,
                niche=niche or "mixed",
            ))
            if len(topics) >= 15:
                break

        duration_ms = int((time.monotonic() - start) * 1000)
        return TrendingResponse(
            topics=topics,
            niche=niche or "all",
            duration_ms=duration_ms,
            generated_at=datetime.now(timezone.utc).isoformat(),
        )

    async def reaction_search(self, topic: str) -> ReactionResponse:
        """Find reaction-worthy content — prioritises YouTube + Reddit + news."""
        start = time.monotonic()

        # Fan out to YouTube, Reddit, and news (best sources for reaction content)
        results = await self._fan_out_specific(
            topic,
            source_names=["youtube", "reddit", "news"],
            max_per=5,
        )
        scored = score_results(results)

        # Build briefs specifically angled for reaction content
        briefs: list[ContentBrief] = []
        from models.research import SourceReference
        for item in scored[:10]:
            r = item.result
            title = r.title.replace("[Mock] ", "")
            short = title.split("—")[0].strip()

            # Determine reaction angle based on source
            if r.source == "youtube":
                angle = f"React to this video — give your take on '{short}'"
                fmt = "YouTube"
            elif r.source == "reddit":
                angle = f"Reddit is going CRAZY over this — '{short}'"
                fmt = "Short"
            else:
                angle = f"Breaking news reaction — '{short}'"
                fmt = "YouTube"

            briefs.append(ContentBrief(
                title=title,
                hook=f"Vocês viram o que está acontecendo com {short}? Eu não acredito...",
                angle=angle,
                format=fmt,
                niche="reaction",
                key_points=[
                    f"Source: {r.source} — {r.url}",
                    r.snippet[:150] if r.snippet else "No preview",
                    "Your hot take + audience engagement question",
                ],
                title_options=[
                    f"REAGINDO a {short}",
                    f"A VERDADE sobre {short} que ninguém fala",
                    f"{short} — Isto é ABSURDO",
                ],
                sources=[SourceReference(
                    title=title, url=r.url,
                    source_type=r.source,
                    relevance_note=f"Score: {item.score.composite:.2f}",
                )],
                score=item.score.composite,
                time_sensitive=item.score.recency >= 0.8,
                why_now=r.snippet[:200] if r.snippet else "Trending now",
            ))

        duration_ms = int((time.monotonic() - start) * 1000)
        return ReactionResponse(
            query=topic,
            briefs=briefs,
            duration_ms=duration_ms,
        )
