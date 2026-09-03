"""
Thumbnail concept generator — detailed visual direction for thumbnails via Claude.
"""

import time
import logging
from models.requests import ThumbnailConcept, ThumbnailRequest, ThumbnailResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt
from services.creative.output_contracts import CreativeOutputContractError, localized_contract_warning, validate_model_list

logger = logging.getLogger("content-engine.thumbnail")

def _build_system_prompt(req: ThumbnailRequest) -> str:
    return f"""You are the authenticated creator's YouTube thumbnail designer.

{creator_profile_block(req)}

{language_instruction(req)}

VISUAL SELECTION CONTRACT:
- Derive palette, imagery, subject treatment, and composition only from the request topic and the authenticated creator's saved visual identity.
- When no visual identity is saved, use a neutral, legible, high-contrast composition that communicates the topic without assigning a genre, ideology, profession, hobby, demographic, or persona.
- Do not infer domain-coded colors, props, software, sports imagery, political stance, game imagery, facial identity, or branded motifs from a default creator profile.
- Use a face or emotional expression only when the request/profile establishes a person-led concept; otherwise use the subject, object, evidence, process, or result itself.
- Text, symbols, screenshots, and diagrams must be grounded in the supplied topic rather than a reusable creator stereotype.

Each concept must include:
- layout: choose a topic-appropriate structure such as "split_screen", "close_up", "text_heavy", "before_after", "subject_detail", "process_demo", "screenshot_focus", or "diagram"
- background_color: exactly one six-digit hex color code; put any palette rationale in why_it_works
- text_overlay: concise main text in the requested language, within the bounded response schema; choose length for legibility and the supplied layout rather than a universal word-count rule. font_style must be one of sans-serif, serif, condensed, display, monospace, script, or bold; color must be exactly one six-digit hex color; position must be one of center, top, bottom, left, right, top-left, top-center, top-right, middle-left, middle-right, bottom-left, bottom-center, or bottom-right
- facial_expression: use "neutral", "focused", "surprised", "skeptical", "excited", or "determined" only when a person-led concept is authorized; otherwise return an empty string
- additional_elements: list only topic-grounded arrows, circles, labels, charts, screenshots, objects, or diagrams; an empty list is valid
- why_it_works: explain why the concept fits the supplied topic, layout, and authenticated creator's saved target audience profile; treat performance as a hypothesis and do not assume a default demographic

Return ONLY a JSON array of 3 concepts. No markdown."""


class _NeutralPromptRequest:
    creator_profile = None
    brand_voice = None
    language = "en-US"


SYSTEM_PROMPT = _build_system_prompt(_NeutralPromptRequest())


async def generate(req: ThumbnailRequest) -> ThumbnailResponse:
    start = time.monotonic()
    system_prompt = _build_system_prompt(req)

    compiled = compile_operation_prompt(OperationPromptInput(
        operation="thumbnail_pack",
        topic=req.topic or req.title,
        language=req.language,
        creator_profile=creator_profile_block(req),
        source_summary=req.source_summary,
        system_prompt=system_prompt,
        user_instruction=f"Video title: {req.title}. Niche: {req.niche}.",
        format_contract=(
            'Return JSON array of 3 concepts with layout, background_color, text_overlay, '
            'facial_expression, additional_elements, why_it_works. Order by strongest topic, brief, and creator-profile fit; '
            'do not claim predicted CTR or platform ranking.'
        ),
    ))

    result = await ask_claude_json(
        compiled.prompt,
        system=system_prompt,
        max_tokens=compiled.output_token_budget or 650,
        category="content_engine_thumbnail",
    )
    warnings: list[str] = []
    try:
        concepts = validate_model_list(result, ThumbnailConcept, expected_items=3)
        if len({concept.model_dump_json() for concept in concepts}) != len(concepts):
            raise CreativeOutputContractError("provider_output_invalid")
        degraded = False
    except CreativeOutputContractError:
        logger.warning("Thumbnail provider output failed the bounded response contract")
        concepts = []
        degraded = True
        warnings.append(localized_contract_warning(req.language, "thumbnail concepts"))

    duration_ms = int((time.monotonic() - start) * 1000)
    return ThumbnailResponse(
        title=req.title,
        concepts=concepts,
        duration_ms=duration_ms,
        degraded=degraded,
        warnings=warnings,
        **build_operation_metadata(req, "thumbnail_pack", compiled, duration_ms=duration_ms),
    )
