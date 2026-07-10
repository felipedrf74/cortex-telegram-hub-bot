import asyncio
import hashlib
import time
import logging
import re
from types import SimpleNamespace
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
from services.creator_context import creator_profile_block, language_instruction
from config import cfg
from datetime import datetime, timezone

logger = logging.getLogger("content-engine")

# Setup-safe broad-topic fallback niches. These fire ONLY when a caller
# does not supply explicit niches (e.g. `trending(niche=None)` AND the
# creator profile has no saved pillars yet). Identity-safety contract
# (closed-beta v4.14.126+): keep these neutral broad-domain queries — no
# political, religious, dietary, or ideological vocabulary, no
# founder-shaped pillar bias. Once the authenticated creator has saved
# their own pillars, callers should pass `niche=<creator_pillar>`
# instead of relying on this fallback.
DEFAULT_NICHES = [
    "technology product launch internet culture",
    "creator economy social media trends",
    "training endurance strength recovery wellness",
    "lifestyle hobbies entertainment",
    "business productivity systems",
]

# Setup-safe broad hot-news fallback queries. Same contract as
# DEFAULT_NICHES: neutral broad-domain coverage; no political,
# religious, dietary, or ideological framing. Per-creator hot-news
# personalization happens downstream in the AI curation step through the
# per-request creator profile, so this raw query set only needs broad coverage,
# not founder pillars.
HOT_NEWS_QUERIES = [
    "technology product launch today",
    "creator economy social media trend today",
    "current events news today",
    "training performance wellness trend today",
    "lifestyle entertainment trend today",
    "business productivity trend today",
    "viral story today",
]

EVERGREEN_HINTS = [
    "recovery", "recover", "interval", "intervals", "training", "workout", "sleep", "hydration",
    "protein", "carb", "nutrition", "readiness", "zone 2", "garmin", "triathlon", "running",
    "cycling", "swimming", "cooldown", "cool down", "hill repeat", "hill repeats",
    "treino", "recuperação", "recuperar", "intervalos", "repetição", "repetições", "sono", "hidratação",
    "proteína", "carboidrato", "nutrição", "prontidão", "corrida", "ciclismo", "natação",
    "desaquecimento", "eletrólitos", "subida", "sessão", "sessões",
]

TIMELY_HINTS = [
    "today", "hoje", "agora", "latest", "breaking", "viral", "trend", "trending", "election",
    "president", "governo", "governo", "política", "economia", "war", "guerra", "news", "notícia",
]

EVERGREEN_RESEARCH_SIGNALS = [
    "guide", "evidence", "study", "review", "protocol", "best practice", "mistake",
    "guia", "evidência", "estudo", "revisão", "protocolo", "melhores práticas", "erros comuns",
]

EVERGREEN_NOISE_SIGNALS = [
    "viral", "trending", "trend", "tendência", "polêmica", "debate", "reaction", "react", "breaking", "drama",
]


def _detect_query_language(query: str) -> str:
    lower = query.lower()
    pt_markers = [
        " recuperação ", " recuperar ", " intervalos ", " repetições ", " treino ",
        " português ", " português europeu ", " depois ", " sobre ", " duro ", " subida ", " triatlo ",
    ]
    en_markers = [
        " recovery ", " recover ", " intervals ", " hill repeat ", " hill repeats ",
        " training ", " english ", " after ", " about ", " hard ", " triathlon ",
    ]
    padded = f" {lower} "
    if any(marker in padded for marker in pt_markers):
        return "pt"
    if any(marker in padded for marker in en_markers):
        return "en"
    return "pt"


def _query_fingerprint(query: str) -> str:
    return hashlib.sha256(query.encode("utf-8")).hexdigest()[:12]


def _is_evergreen_query(query: str) -> bool:
    lower = query.lower()
    has_evergreen = any(hint in lower for hint in EVERGREEN_HINTS)
    has_timely = any(hint in lower for hint in TIMELY_HINTS)
    return has_evergreen and not has_timely


def _build_search_variations(query: str, verification_queries: list[str]) -> list[str]:
    language = _detect_query_language(query)
    evergreen = _is_evergreen_query(query)

    if evergreen and language == "en":
        base_variations = [
            query,
            f"{query} evidence based guide",
            f"{query} study review protocol",
            f"{query} coaching science best practices",
            f"{query} common mistakes practical takeaway",
        ]
    elif evergreen:
        base_variations = [
            query,
            f"{query} guia prático baseado em evidência",
            f"{query} estudo revisão protocolo",
            f"{query} ciência treino melhores práticas",
            f"{query} erros comuns aplicação prática",
        ]
    elif language == "en":
        base_variations = [
            query,
            f"{query} data statistics numbers",
            f"{query} opinion critical analysis",
            f"{query} controversy debate consequences",
            f"{query} YouTube viral trend reaction",
        ]
    else:
        base_variations = [
            query,
            f"{query} dados estatísticas números Brasil",
            f"{query} opinião análise crítica",
            f"{query} polêmica debate consequências",
            f"{query} YouTube vídeo viral tendência",
        ]

    combined = base_variations + verification_queries
    return list(dict.fromkeys(combined))


def _query_specific_rank(item: ScoredResult, evergreen: bool) -> float:
    score = item.score.composite
    if not evergreen:
        return score

    text = f"{item.result.title} {item.result.snippet}".lower()
    score += sum(0.08 for signal in EVERGREEN_RESEARCH_SIGNALS if signal in text)
    score -= sum(0.18 for signal in EVERGREEN_NOISE_SIGNALS if signal in text)

    if item.result.source in {"reddit", "news"}:
        score += 0.05
    return score


def _dedupe_scored_by_url(scored: list[ScoredResult]) -> list[ScoredResult]:
    seen_urls: set[str] = set()
    unique_scored: list[ScoredResult] = []
    for item in scored:
        if item.result.url in seen_urls:
            continue
        seen_urls.add(item.result.url)
        unique_scored.append(item)
    return unique_scored


def _creator_context(creator_profile: str | None = None, language: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(creator_profile=creator_profile, language=language)


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

    async def quick_search(
        self,
        query: str,
        max_results: int = 3,
        language: str | None = None,
    ) -> DeepSearchResponse:
        """Cheap research path for cache-miss quick mode — no AI synthesis, single fan-out, conservative briefs."""
        start = time.monotonic()
        results = await self._fan_out(query, max_per_searcher=2)
        scored = score_results(results)
        unique_scored = _dedupe_scored_by_url(scored)

        briefs = build_briefs(unique_scored, max_briefs=max_results, language=language)
        duration_ms = int((time.monotonic() - start) * 1000)
        return DeepSearchResponse(
            query=query,
            briefs=briefs,
            search_count=len(self.searchers),
            duration_ms=duration_ms,
            degraded=False,
            warnings=["Quick mode used shallow research without AI synthesis."],
        )

    async def deep_search(
        self,
        query: str,
        niches: list[str] | None = None,
        max_results: int = 10,
        creator_profile: str | None = None,
        language: str | None = None,
    ) -> DeepSearchResponse:
        """Full research pipeline: fan-out → score → AI synthesis → actionable briefs."""
        import json
        from services.claude_client import AiProxyError, ask_claude_json, MODEL

        start = time.monotonic()
        warnings: list[str] = []

        # Phase 0: Add verification queries for high-risk topics
        from services.source_registry import get_verification_queries
        verification_queries = get_verification_queries(query)
        evergreen_query = _is_evergreen_query(query)

        # Phase 1: Wide search — query + variations for depth + verification
        search_variations = _build_search_variations(query, verification_queries)

        semaphore = asyncio.Semaphore(4)

        async def run_variation(q: str) -> list[SearchResult]:
            async with semaphore:
                return await self._fan_out(q, max_per_searcher=5)

        tasks = [asyncio.create_task(run_variation(q)) for q in search_variations]
        done, pending = await asyncio.wait(tasks, timeout=max(0.05, float(cfg.pipeline_timeout)))
        if pending:
            warnings.append("Search fanout hit the pipeline timeout; returning completed sources only.")
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        var_results = []
        for task in done:
            try:
                var_results.append(task.result())
            except Exception as exc:
                var_results.append(exc)

        all_results: list[SearchResult] = []
        for i, results in enumerate(var_results):
            if isinstance(results, Exception):
                variation = search_variations[i]
                logger.warning(
                    "Search variation failed (query_hash=%s query_len=%d): %s",
                    _query_fingerprint(variation),
                    len(variation),
                    results,
                )
                continue
            all_results.extend(results)

        search_count = len(search_variations) * len(self.searchers)
        scored = score_results(all_results)
        unique_scored = _dedupe_scored_by_url(scored)

        selected_scored = sorted(
            unique_scored,
            key=lambda item: _query_specific_rank(item, evergreen_query),
            reverse=True,
        )

        # Build raw source data for Claude
        raw_sources = []
        for item in selected_scored[:25]:
            raw_sources.append({
                "title": item.result.title.replace("[Mock] ", ""),
                "url": item.result.url,
                "snippet": (item.result.snippet or "")[:300],
                "source_type": item.result.source,
                "score": round(item.score.composite, 2),
                "published": item.result.published_at.isoformat() if item.result.published_at else None,
            })

        if not raw_sources:
            # Fallback to old brief builder if no results
            briefs = build_briefs(selected_scored, max_briefs=max_results, language=language)
            duration_ms = int((time.monotonic() - start) * 1000)
            warnings.append("No strong research sources were found; returning conservative fallback briefs.")
            return DeepSearchResponse(
                query=query,
                briefs=briefs,
                search_count=search_count,
                duration_ms=duration_ms,
                degraded=True,
                warnings=warnings,
            )

        creator_context = _creator_context(creator_profile=creator_profile, language=language)

        # Phase 2: AI synthesis — Claude analyzes all sources and builds real briefs
        synthesis_prompt = f"""You are the creator's deep research analyst.
Use the creator configuration below as the canonical source of worldview, audience, editorial fit, and language defaults.

CREATOR CONFIG:
{creator_profile_block(creator_context)}

TOPIC: {query}

LANGUAGE:
{language_instruction(creator_context)}

I found {len(raw_sources)} sources. Here they are:

{json.dumps(raw_sources, ensure_ascii=False, indent=1)}

YOUR TASK — produce a {"DEEP RESEARCH BRIEF" if not evergreen_query else "PRACTICAL EVERGREEN RESEARCH BRIEF"} in JSON with this structure:
{{
  "summary": "3-5 sentence executive summary of what's happening with this topic right now",
  "key_facts": ["fact 1 with specific data/numbers", "fact 2", "fact 3", "fact 4", "fact 5"],
  "arguments_for": ["argument supporting the mainstream position"],
  "arguments_against": ["counter-argument / the creator's likely contrarian take"],
  "creator_angle": "How the authenticated creator should approach this — using their saved brand voice, worldview, and audience profile from the creator memory; do not assume any specific political or ideological default",
  "content_ideas": [
    {{
      "title": "Compelling title in the creator's saved primary content language",
      "hook": "Scroll-stopping opening line in the creator's saved primary content language (conversational, not clickbait)",
      "format": "YouTube|Reel|Short",
      "key_points": ["specific talking point 1 with data", "point 2", "point 3"],
      "why_now": "Why this matters RIGHT NOW",
      "time_sensitive": true/false
    }}
  ],
  "best_sources": [
    {{"title": "...", "url": "...", "source_type": "...", "why_useful": "what data/insight this provides"}}
  ]
}}

RULES:
- Generate 3-5 content_ideas, each with a DIFFERENT angle on the topic
- Include SPECIFIC data, numbers, statistics from the sources
- key_points should be concrete talking points, not vague platitudes
- hooks must be conversational in the creator's saved primary content language; if the creator has no saved language, mirror the language of the supplied TOPIC. Do NOT default to any specific language.
- best_sources: pick the 5-8 most useful, explain WHY each is useful
- All free-text fields use the creator's saved primary content language; field names stay in English.
- {"For evergreen training/health/performance topics, do NOT manufacture virality. Treat `why_now` as practical relevance and usually keep `time_sensitive` false unless the sources clearly prove timeliness." if evergreen_query else "For timely commentary topics, explain the urgency clearly and use `time_sensitive` when the window is actually short."}

Return ONLY the JSON object."""

        try:
            synthesis = await ask_claude_json(
                synthesis_prompt,
                model=MODEL,
                max_tokens=6144,
                temperature=0.6,
                category="content_engine_deepsearch",
            )
            if isinstance(synthesis, dict) and "raw" in synthesis and len(synthesis) == 1:
                raise ValueError("JSON parse failed")
        except AiProxyError:
            raise
        except Exception as e:
            logger.warning("AI synthesis failed, falling back to basic briefs: %s", e)
            briefs = build_briefs(selected_scored, max_briefs=max_results, language=language)
            duration_ms = int((time.monotonic() - start) * 1000)
            warnings.append("AI synthesis was unavailable; returning search-based fallback briefs.")
            return DeepSearchResponse(
                query=query,
                briefs=briefs,
                search_count=search_count,
                duration_ms=duration_ms,
                degraded=True,
                warnings=warnings,
            )

        # Phase 3: Convert AI synthesis into ContentBrief objects
        from models.research import SourceReference
        briefs: list[ContentBrief] = []

        # Store synthesis metadata in the first brief's why_now
        summary = synthesis.get("summary", "")
        key_facts = synthesis.get("key_facts", [])
        # nx-allow-identity-scan: backward-compat read for payloads persisted before the field rename.
        creator_angle = synthesis.get("creator_angle", synthesis.get("felipes_angle", ""))  # creator_angle is the new key; fall back to legacy felipes_angle for older payloads
        args_for = synthesis.get("arguments_for", [])
        args_against = synthesis.get("arguments_against", [])

        # Build source references from AI-curated best_sources
        best_sources = []
        for src in synthesis.get("best_sources", []):
            best_sources.append(SourceReference(
                title=src.get("title", ""),
                url=src.get("url", ""),
                source_type=src.get("source_type", "web"),
                relevance_note=src.get("why_useful", ""),
            ))

        for idea in synthesis.get("content_ideas", [])[:5]:
            brief = ContentBrief(
                title=idea.get("title", query),
                hook=idea.get("hook", ""),
                angle=creator_angle,
                format=idea.get("format", "YouTube"),
                niche="deep_research",
                key_points=idea.get("key_points", []),
                title_options=[idea.get("title", query)],
                sources=best_sources,
                score=0.9,
                time_sensitive=idea.get("time_sensitive", False),
                why_now=idea.get("why_now", ""),
            )
            briefs.append(brief)

        # Inject research context into first brief.
        # Identity-safety: section labels are English (the API contract
        # language); free-text content (`summary`, `key_facts`,
        # `creator_angle`) carries the creator's saved language as
        # produced by the AI synthesis above. The previous hardcoded
        # PT-BR labels ("RESUMO", "FATOS-CHAVE", "ARGUMENTOS A FAVOR",
        # "CONTRA-ARGUMENTOS", "ÂNGULO DO CRIADOR") asserted PT-BR
        # identity into every authenticated user's first brief; fixed
        # in v4.14.126 closed-beta hardening.
        if briefs:
            research_block = f"SUMMARY: {summary}"
            if key_facts:
                research_block += "\n\nKEY FACTS:\n" + "\n".join(f"• {f}" for f in key_facts)
            if args_for:
                research_block += "\n\nARGUMENTS FOR:\n" + "\n".join(f"• {a}" for a in args_for)
            if args_against:
                research_block += "\n\nARGUMENTS AGAINST:\n" + "\n".join(f"• {a}" for a in args_against)
            research_block += f"\n\nCREATOR ANGLE: {creator_angle}"
            briefs[0].why_now = research_block

        duration_ms = int((time.monotonic() - start) * 1000)
        logger.info("deep_search (AI) completed: %d sources → %d briefs in %dms", len(raw_sources), len(briefs), duration_ms)

        return DeepSearchResponse(
            query=query,
            briefs=briefs,
            search_count=search_count,
            duration_ms=duration_ms,
            degraded=False,
            warnings=warnings,
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

    async def hot_news(
        self,
        creator_profile: str | None = None,
        language: str | None = None,
    ) -> HotNewsResponse:
        """What's trending right now — curated through the creator's saved worldview lens."""
        from services.claude_client import AiProxyError, ask_claude_json, FAST_MODEL

        # Phase 1: Gather raw results from targeted queries
        query_tasks = [self._fan_out(q, max_per_searcher=3) for q in HOT_NEWS_QUERIES]
        query_results = await asyncio.gather(*query_tasks, return_exceptions=True)

        # Collect all raw results
        all_raw: list[dict] = []
        for i, results in enumerate(query_results):
            if isinstance(results, Exception):
                logger.warning("Hot news fan-out failed for '%s': %s", HOT_NEWS_QUERIES[i], results)
                continue
            scored = score_results(results)
            for item in scored[:4]:
                all_raw.append({
                    "title": item.result.title.replace("[Mock] ", ""),
                    "snippet": (item.result.snippet or "")[:200],
                    "source": item.result.source,
                    "url": item.result.url,
                    "heat": round(item.score.composite, 2),
                    "query_niche": HOT_NEWS_QUERIES[i].split()[0],
                    "published": item.result.published_at.isoformat() if item.result.published_at else None,
                })

        if not all_raw:
            return HotNewsResponse(topics=[], generated_at=datetime.now(timezone.utc).isoformat())

        # Phase 2: AI curation — filter and rank through creator lens
        import json
        # Identity-safety: the niche classification list is no longer a  # nx-allow-identity-scan
        # hardcoded enum (the previous list — "politica | economia |  # nx-allow-identity-scan
        # fitness | fe_familia | geopolitica | desenvolvimento |  # nx-allow-identity-scan
        # reacao" — leaked the founder's pillars, including the  # nx-allow-identity-scan
        # `fe_familia` faith/family ideology label, into every  # nx-allow-identity-scan
        # authenticated user's hot-news metadata). The model is now
        # instructed to choose a niche label drawn from the creator's
        # saved pillars in the creator profile, falling back to a
        # generic broad-content label only when the creator has no
        # saved pillars.
        creator_context = _creator_context(creator_profile=creator_profile, language=language)

        curation_prompt = f"""You are the creator's content curator.
Use the creator configuration below as the canonical source of editorial fit, audience, worldview, language defaults, and pillar labels.

CREATOR CONFIG:
{creator_profile_block(creator_context)}

LANGUAGE:
{language_instruction(creator_context)}

Here are {len(all_raw)} trending topics found right now:

{json.dumps(all_raw, ensure_ascii=False, indent=1)}

TASK: Select the TOP 8 most interesting topics for the authenticated creator's content. For each:
1. Rewrite the title as a compelling headline the authenticated creator would use, in their saved primary content language (do NOT default to any specific language unless it is the creator's saved language).
2. Add a "content_angle" — how the authenticated creator should approach this, in their saved voice and through their saved worldview / audience profile (do NOT inject political, religious, or ideological defaults).
3. Rate "relevance" 1-10 (how well it fits their brand).
4. Classify the "niche" using a label drawn from the creator's saved pillars in the creator profile. If the creator has no saved pillars, use a generic broad-content label such as "technology", "creator-economy", "wellness", "lifestyle", or "business". Do NOT use default worldview, belief-system, political, dietary, or demographic labels unless they appear explicitly in the creator's saved pillars.

Return JSON array:
[{{"title": "...", "content_angle": "...", "relevance": 9, "niche": "...", "heat_score": 0.85, "sources": ["..."], "original_title": "..."}}]

Only return the JSON array, nothing else."""

        try:
            curated = await ask_claude_json(curation_prompt, model=FAST_MODEL, max_tokens=4096, temperature=0.6)
            if isinstance(curated, dict) and "raw" in curated:
                curated = []  # JSON parse failed
        except AiProxyError:
            raise
        except Exception as e:
            logger.warning("AI curation failed, falling back to raw: %s", e)
            curated = []

        topics: list[TrendingTopic] = []

        if curated and isinstance(curated, list):
            for item in curated[:8]:
                topics.append(TrendingTopic(
                    topic=item.get("title", ""),
                    heat_score=float(item.get("heat_score", 0.5)),
                    sources=item.get("sources", []),
                    first_seen=None,
                    niche=item.get("niche", "geral"),
                    content_angle=item.get("content_angle", ""),
                    relevance=item.get("relevance", 5),
                ))
        else:
            # Fallback: raw results without curation
            for item in all_raw[:8]:
                topics.append(TrendingTopic(
                    topic=item["title"],
                    heat_score=item["heat"],
                    sources=[item["source"]],
                    first_seen=None,
                    niche=item["query_niche"],
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

            # Identity-safety: hook/title_options template strings are
            # in English (the API contract language). The previous
            # hardcoded PT-BR templates ("Vocês viram...", "REAGINDO
            # a...", "A VERDADE sobre...") asserted PT-BR identity
            # into every authenticated user's reaction briefs. The
            # caller (TS workflow) is expected to localize/AI-rewrite
            # these strings into the creator's saved primary content
            # language as a downstream step. Fixed in v4.14.126
            # closed-beta hardening.
            briefs.append(ContentBrief(
                title=title,
                hook=f"Did you see what's happening with {short}? I can't believe it...",
                angle=angle,
                format=fmt,
                niche="reaction",
                key_points=[
                    f"Source: {r.source} — {r.url}",
                    r.snippet[:150] if r.snippet else "No preview",
                    "Your hot take + audience engagement question",
                ],
                title_options=[
                    f"REACTING to {short}",
                    f"The TRUTH about {short} that nobody talks about",
                    f"{short} — This is OUTRAGEOUS",
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
