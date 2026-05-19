"""
Content gap finder — discovers topics with high demand but low supply.

Uses the research orchestrator to search existing content, then asks Claude
to identify gaps and opportunities.
"""

import time
import logging
from models.requests import GapsRequest, GapsResponse
from services.claude_client import ask_claude_json
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt

logger = logging.getLogger("content-engine.gaps")

# Seed topics per niche to scan for gaps
NICHE_SEED_TOPICS = {
    "fitness": [
        "beginner hybrid training plan",
        "strength training for runners",
        "running and gym schedule",
        "recovery routine for endurance athletes",
        "meal prep for active weeks",
        "training consistency for busy people",
    ],
    "commentary": [
        "creator economy trends",
        "internet culture debate",
        "reaction to platform changes",
        "audience trust in creators",
        "media trend analysis",
    ],
}

SYSTEM_PROMPT = """You are a content gap analysis expert for YouTube/Instagram.
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
- suggested_angle: how the authenticated creator should approach this differently
- suggested_title: a title for this content

Return ONLY a JSON array. Match the language implied by the requested niche/topics; do not assume a default creator identity, worldview, country, or dietary pattern."""


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

    compiled = compile_operation_prompt(OperationPromptInput(
        operation="gap_insight",
        topic=req.niche,
        language="en-US",
        source_summary=[
            f"{s['topic']}: {s['result_count']} results; {', '.join(s['sample_titles'][:2])}"
            for s in research_summaries
        ],
        user_instruction=f"Find top {req.max_gaps} gaps for niche={req.niche}.",
        format_contract=(
            f"Analyze these summarized research results for the {req.niche} niche:\n{context}\n\n"
            "Return JSON array with topic, gap_type, search_demand, existing_content_quality, opportunity_score, suggested_angle, suggested_title."
        ),
    ))

    try:
        gaps = await ask_claude_json(compiled.prompt, system=SYSTEM_PROMPT, max_tokens=1600)
    except Exception as e:
        # 2026-05-18 phase2-qa P2: do NOT leak the raw exception message to
        # the client. The internal proxy error format
        # (`f"AI proxy error {status} for category={category}"`) and any
        # downstream provider trace must not reach iOS. Log to server, return
        # a stable client-facing code.
        logger.error("Claude call failed in gap_finder: %s", e)
        duration_ms = int((time.monotonic() - start) * 1000)
        return GapsResponse(
            niche=req.niche,
            gaps=[{"topic": "Analysis unavailable", "gap_type": "error", "error": "provider_unavailable"}],
            duration_ms=duration_ms,
            **build_operation_metadata(req, "gap_insight", compiled),
        )

    # Handle non-JSON / malformed response
    if isinstance(gaps, dict) and "raw" in gaps and len(gaps) == 1:
        raw_len = len(str(gaps.get("raw", "")))
        logger.warning("Claude returned non-JSON in gap_finder (%d chars)", raw_len)
        gaps_list = []
    else:
        gaps_list = gaps if isinstance(gaps, list) else [gaps]

    duration_ms = int((time.monotonic() - start) * 1000)
    return GapsResponse(
        niche=req.niche,
        gaps=gaps_list[:req.max_gaps],
        duration_ms=duration_ms,
        **build_operation_metadata(req, "gap_insight", compiled),
    )
