"""
SEO keyword engine — keyword research optimised for YouTube + Instagram via Claude.

Uses search results to understand competition, then generates keyword clusters
with content recommendations.
"""

import time
import logging
from models.requests import SeoRequest, SeoResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction

logger = logging.getLogger("content-engine.seo")

def _build_system_prompt(req: SeoRequest) -> str:
    return f"""You are a YouTube/Instagram SEO expert.

{creator_profile_block(req)}

{language_instruction(req)}

Your job is to take a seed topic and produce a keyword analysis:
1. Expand the seed into 15-20 long-tail keyword variations
2. Cluster keywords by topic group
3. Score each cluster: estimated search volume × (1 / competition) = opportunity score
4. Map clusters to content types (tutorial, reaction, opinion, story, listicle)

For each keyword cluster provide:
- keyword: the primary keyword phrase
- variations: related long-tail keywords (array)
- estimated_volume: "high" | "medium" | "low"
- competition: "high" | "medium" | "low"
- opportunity_score: 1-10
- content_type: suggested format
- suggested_title: a title using this keyword
- notes: any platform-specific SEO tips

Return ONLY a JSON array of cluster objects."""


async def analyze(req: SeoRequest, orchestrator) -> SeoResponse:
    start = time.monotonic()

    # Research the topic to understand competition landscape
    try:
        results = await orchestrator._fan_out(req.topic, max_per_searcher=5)
        existing_titles = [r.title for r in results[:10]]
    except Exception:
        existing_titles = []

    title_context = "\n".join(f"- {t}" for t in existing_titles) if existing_titles else "No existing content found."

    prompt = f"""Perform a keyword analysis for:
- Seed topic: {req.topic}
- Platform: {req.platform}
- Target language: {req.language}

Existing content in this space:
{title_context}

Generate 8-12 keyword clusters with long-tail variations, volume estimates,
competition analysis, and specific content recommendations.

Return JSON array of cluster objects."""

    clusters = await ask_claude_json(prompt, system=_build_system_prompt(req))
    clusters_list = clusters if isinstance(clusters, list) else [clusters]

    duration_ms = int((time.monotonic() - start) * 1000)
    return SeoResponse(
        topic=req.topic,
        clusters=clusters_list,
        duration_ms=duration_ms,
    )
