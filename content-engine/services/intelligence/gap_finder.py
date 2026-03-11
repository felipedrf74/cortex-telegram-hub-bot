"""
Content gap finder — discovers topics with high demand but low supply.

Uses the research orchestrator to search existing content, then asks Claude
to identify gaps and opportunities.
"""

import time
import logging
from models.requests import GapsRequest, GapsResponse
from services.claude_client import ask_claude_json

logger = logging.getLogger("content-engine.gaps")

# Seed topics per niche to scan for gaps
NICHE_SEED_TOPICS = {
    "fitness": [
        "treino híbrido para iniciantes",
        "dieta carnívora resultados",
        "corrida e musculação juntos",
        "treino de força para corredores",
        "atleta híbrido rotina",
        "carnívoro e performance esportiva",
    ],
    "commentary": [
        "polêmica influencer brasil",
        "opinião impopular cultura",
        "reaction tendências brasil",
        "cancelamento redes sociais",
        "debate político análise",
    ],
}

SYSTEM_PROMPT = """You are a content gap analysis expert for PT-BR YouTube/Instagram.
A "content gap" is a topic with HIGH search demand but LOW content supply.

GAP TYPES:
- 🟢 BIG OPPORTUNITY: High demand + few existing videos (< 20 results, or all outdated)
- 🟡 QUALITY GAP: Many videos exist but all are low quality, outdated, or miss key angles
- 🔴 SATURATED: Many high-quality videos exist — skip or find a unique angle

For each gap, provide:
- topic: the specific content topic
- gap_type: "big_opportunity" | "quality_gap" | "saturated"
- search_demand: "high" | "medium" | "low"
- existing_content_quality: "none" | "low" | "medium" | "high"
- opportunity_score: 1-10
- suggested_angle: how Felipe should approach this differently
- suggested_title: a title for this content

Return ONLY a JSON array. Language: PT-BR."""


async def find(req: GapsRequest, orchestrator) -> GapsResponse:
    start = time.monotonic()

    # Get seed topics for the niche
    seed_topics = NICHE_SEED_TOPICS.get(req.niche, NICHE_SEED_TOPICS["fitness"])

    # Research each seed topic
    research_summaries = []
    for topic in seed_topics[:5]:
        try:
            results = await orchestrator._fan_out(topic, max_per_searcher=3)
            research_summaries.append({
                "topic": topic,
                "result_count": len(results),
                "sample_titles": [r.title for r in results[:3]],
            })
        except Exception as e:
            logger.warning("Gap research failed for '%s': %s", topic, e)

    context = "\n".join(
        f"- '{s['topic']}': {s['result_count']} results found. Titles: {', '.join(s['sample_titles'][:2])}"
        for s in research_summaries
    )

    prompt = f"""Analyze these content research results for the "{req.niche}" niche and identify content gaps:

{context}

Based on this data and your knowledge of PT-BR content landscape,
identify the top {req.max_gaps} content gaps — topics where there's demand but insufficient supply.

Return JSON array of gap objects with: topic, gap_type, search_demand, existing_content_quality, opportunity_score, suggested_angle, suggested_title."""

    gaps = await ask_claude_json(prompt, system=SYSTEM_PROMPT)
    gaps_list = gaps if isinstance(gaps, list) else [gaps]

    duration_ms = int((time.monotonic() - start) * 1000)
    return GapsResponse(
        niche=req.niche,
        gaps=gaps_list[:req.max_gaps],
        duration_ms=duration_ms,
    )
