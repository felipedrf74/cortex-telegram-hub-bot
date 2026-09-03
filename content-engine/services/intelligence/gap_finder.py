"""
Content gap finder — discovers topics with high demand but low supply.

Uses the research orchestrator to search existing content, then asks Claude
to identify gaps and opportunities.
"""

import time
import logging
from models.requests import GapInsightPayload, GapsRequest, GapsResponse
from services.claude_client import AiProxyError, ask_claude_json
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt
from services.creative.output_contracts import (
    CreativeOutputContractError,
    localized_contract_warning,
    localized_research_warning,
    validate_bounded_model_list,
)

logger = logging.getLogger("content-engine.gaps")


async def _research_fan_out(orchestrator, topic: str, language: str) -> tuple[list, int]:
    health_aware = getattr(orchestrator, "_fan_out_with_health", None)
    if callable(health_aware):
        return await health_aware(topic, max_per_searcher=3, language=language)
    return await orchestrator._fan_out(topic, max_per_searcher=3, language=language), 0


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
NICHE_SEED_TOPICS_PT_PT = {
    "fitness": [
        "plano de treino híbrido para principiantes",
        "treino de força para corredores",
        "agenda de corrida e ginásio",
        "rotina de recuperação para atletas de resistência",
        "preparação de refeições para semanas ativas",
        "consistência no treino para pessoas ocupadas",
    ],
    "commentary": [
        "tendências da economia dos criadores",
        "debate sobre cultura da internet",
        "reação a mudanças nas plataformas",
        "confiança do público nos criadores",
        "análise de tendências dos media",
    ],
}
NICHE_SEED_TOPICS_PT_BR = {
    "fitness": [
        "plano de treino híbrido para iniciantes",
        "treino de força para corredores",
        "rotina de corrida e academia",
        "recuperação para atletas de resistência",
        "preparo de refeições para semanas ativas",
        "consistência no treino para pessoas ocupadas",
    ],
    "commentary": [
        "tendências da economia dos criadores",
        "debate sobre cultura da internet",
        "reação a mudanças nas plataformas",
        "confiança do público nos criadores",
        "análise de tendências da mídia",
    ],
}


def _seed_topics_for_niche(niche: str, language: str) -> list[str]:
    locale = (language or "en-US").strip().lower()
    configured_topics = (
        NICHE_SEED_TOPICS_PT_PT
        if locale == "pt-pt"
        else NICHE_SEED_TOPICS_PT_BR
        if locale == "pt-br"
        else NICHE_SEED_TOPICS
    )
    configured = configured_topics.get(niche.lower())
    if configured:
        return configured

    # An unfamiliar creator niche is still authoritative request context. Build
    # neutral research intents from that niche instead of substituting another
    # creator's subject matter.
    if locale == "pt-pt":
        return [
            niche,
            f"{niche} perguntas do público",
            f"{niche} problemas comuns",
            f"{niche} conselhos desatualizados",
            f"{niche} temas pouco explorados",
        ]
    if locale == "pt-br":
        return [
            niche,
            f"{niche} dúvidas do público",
            f"{niche} problemas comuns",
            f"{niche} conselhos desatualizados",
            f"{niche} temas pouco explorados",
        ]
    return [
        niche,
        f"{niche} audience questions",
        f"{niche} common problems",
        f"{niche} outdated advice",
        f"{niche} underserved topics",
    ]

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

Return ONLY a JSON array. Follow the request-authoritative language supplied in the operation prompt; do not infer language from niche or search-result titles, and do not assume a default creator identity, worldview, country, or dietary pattern."""


def _build_system_prompt(req: GapsRequest) -> str:
    return f"""{SYSTEM_PROMPT}

{creator_profile_block(req)}

{language_instruction(req)}"""


async def find(req: GapsRequest, orchestrator) -> GapsResponse:
    start = time.monotonic()

    # Use configured research depth for known categories; otherwise derive
    # neutral queries from the explicit creator-supplied niche.
    seed_topics = _seed_topics_for_niche(req.niche, req.language)

    # Research each seed topic
    research_summaries = []
    research_failure_count = 0
    for topic in seed_topics[:5]:
        try:
            results, failed_searchers = await _research_fan_out(orchestrator, topic, req.language)
            research_failure_count += failed_searchers
            research_summaries.append({
                "topic": topic,
                "result_count": len(results),
                "sample_titles": [r.title for r in results[:3]],
            })
        except Exception:
            research_failure_count += 1
            logger.warning("Gap research failed (stage=fanout error_type=provider_or_transport)")

    system_prompt = _build_system_prompt(req)
    compiled = compile_operation_prompt(OperationPromptInput(
        operation="gap_insight",
        topic=req.niche,
        language=req.language,
        creator_profile=creator_profile_block(req),
        source_summary=[
            f"{s['topic']}: {s['result_count']} results; {', '.join(s['sample_titles'][:2])}"
            for s in research_summaries
        ],
        user_instruction=f"Find top {req.max_gaps} gaps for niche={req.niche}.",
        format_contract=(
            "Analyze only the separately delimited untrusted source summary. Return a direct JSON array with "
            "topic, gap_type, search_demand, existing_content_quality, opportunity_score, suggested_angle, suggested_title."
        ),
        system_prompt=system_prompt,
    ))

    warnings: list[str] = []
    research_degraded = research_failure_count > 0 or not any(
        summary["result_count"] > 0 for summary in research_summaries
    )
    if research_degraded:
        warnings.append(localized_research_warning(req.language, "content gaps"))
    try:
        gaps = await ask_claude_json(
            compiled.prompt,
            system=system_prompt,
            max_tokens=compiled.output_token_budget or 1500,
            category="content_engine_gaps",
        )
    except AiProxyError:
        raise
    except Exception:
        # 2026-05-18 phase2-qa P2: do NOT leak the raw exception message to
        # the client. The internal proxy error format
        # (`f"AI proxy error {status} for category={category}"`) and any
        # downstream provider trace must not reach iOS. Log to server, return
        # a stable client-facing code.
        logger.error("Gap synthesis failed (stage=model error_type=provider_or_transport)")
        duration_ms = int((time.monotonic() - start) * 1000)
        warnings.append(localized_contract_warning(req.language, "content gaps"))
        return GapsResponse(
            niche=req.niche,
            gaps=[],
            duration_ms=duration_ms,
            degraded=True,
            warnings=warnings,
            **build_operation_metadata(req, "gap_insight", compiled, duration_ms=duration_ms),
        )

    try:
        gaps_list = [
            gap.model_dump(exclude_none=True)
            for gap in validate_bounded_model_list(
                gaps,
                GapInsightPayload,
                min_items=0,
                max_items=req.max_gaps,
            )
        ]
        degraded = research_degraded
    except CreativeOutputContractError:
        logger.warning("Gap provider output failed the bounded response contract")
        gaps_list = []
        degraded = True
        warnings.append(localized_contract_warning(req.language, "content gaps"))

    duration_ms = int((time.monotonic() - start) * 1000)
    return GapsResponse(
        niche=req.niche,
        gaps=gaps_list,
        duration_ms=duration_ms,
        degraded=degraded,
        warnings=warnings,
        **build_operation_metadata(req, "gap_insight", compiled, duration_ms=duration_ms),
    )
