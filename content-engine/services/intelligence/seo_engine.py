"""
SEO keyword engine — keyword research optimised for YouTube + Instagram via Claude.

Uses search results to understand competition, then generates keyword clusters
with content recommendations.
"""

import time
import logging
from models.requests import SeoClusterPayload, SeoRequest, SeoResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt
from services.creative.output_contracts import (
    CreativeOutputContractError,
    localized_contract_warning,
    localized_research_warning,
    validate_bounded_model_list,
)

logger = logging.getLogger("content-engine.seo")


async def _research_fan_out(orchestrator, topic: str, language: str) -> tuple[list, int]:
    health_aware = getattr(orchestrator, "_fan_out_with_health", None)
    if callable(health_aware):
        return await health_aware(topic, max_per_searcher=5, language=language)
    return await orchestrator._fan_out(topic, max_per_searcher=5, language=language), 0


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
        results, failed_searchers = await _research_fan_out(orchestrator, req.topic, req.language)
        existing_titles = [r.title for r in results[:10]]
    except Exception:
        existing_titles = []
        failed_searchers = 1
    research_degraded = failed_searchers > 0 or not existing_titles

    system_prompt = _build_system_prompt(req)
    compiled = compile_operation_prompt(OperationPromptInput(
        operation="seo_insight",
        topic=req.topic,
        language=req.language,
        creator_profile=creator_profile_block(req),
        source_summary=existing_titles[:10],
        user_instruction=f"Platform: {req.platform}",
        format_contract=(
            "Analyze only the separately delimited untrusted source summary. Generate a direct JSON array of "
            "8-12 keyword clusters with long-tail variations, volume estimates, competition analysis, and recommendations."
        ),
        system_prompt=system_prompt,
    ))

    clusters = await ask_claude_json(
        compiled.prompt,
        system=system_prompt,
        max_tokens=compiled.output_token_budget or 1500,
        category="content_engine_seo",
    )
    warnings: list[str] = []
    if research_degraded:
        warnings.append(localized_research_warning(req.language, "SEO analysis"))
    try:
        clusters_list = [
            cluster.model_dump(exclude_none=True)
            for cluster in validate_bounded_model_list(
                clusters,
                SeoClusterPayload,
                min_items=1,
                max_items=12,
            )
        ]
        degraded = research_degraded
    except CreativeOutputContractError:
        logger.warning("SEO provider output failed the bounded response contract")
        clusters_list = []
        degraded = True
        warnings.append(localized_contract_warning(req.language, "SEO clusters"))

    duration_ms = int((time.monotonic() - start) * 1000)
    return SeoResponse(
        topic=req.topic,
        clusters=clusters_list,
        duration_ms=duration_ms,
        degraded=degraded,
        warnings=warnings,
        **build_operation_metadata(req, "seo_insight", compiled, duration_ms=duration_ms),
    )
