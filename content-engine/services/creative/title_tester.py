"""Title variant reviewer — generates bounded creative hypotheses and scores fit."""

import time
import logging
from models.requests import TitleVariant, TitlesRequest, TitlesResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt
from services.creative.output_contracts import CreativeOutputContractError, localized_contract_warning, validate_model_list

logger = logging.getLogger("content-engine.titles")

def _build_system_prompt(req: TitlesRequest) -> str:
    return f"""You are the creator's YouTube/Instagram title specialist.

{creator_profile_block(req)}

{language_instruction(req)}

STRATEGIES to use (mix them):
- NUMBER: A concrete, request-grounded list or quantity
- QUESTION: A clear question that opens a topic-relevant information gap
- HOW_TO: A specific path to a supportable outcome, rendered entirely in the requested language
- BOLD_CLAIM: A strong but supportable claim grounded in the supplied topic
- VS: Compare two alternatives that the request actually establishes, rendered entirely in the requested language
- STORY: First-person experience only when the authenticated creator profile or request provides it
- CONTROVERSY: Contrarian framing only when topic and creator profile support it
- URGENCY: A timely information gap only when supplied evidence establishes timing
- CONTRARIAN: A supportable alternative view only when the saved creator stance or request establishes it

SCORING (0-100) based on:
- Clarity and readability within the operation's hard character bound; no length range is assumed to improve platform ranking
- Clarity and specificity without forced capitalization or clickbait
- Natural placement of the request's primary topic language
- Audience relevance grounded in the authenticated creator profile when available
- Brand alignment with the creator configuration above
- Promise/deliverability balance. The score is a creative-review hypothesis, not predicted platform performance

Return ONLY a JSON array. No markdown."""


class _NeutralPromptRequest:
    creator_profile = None
    brand_voice = None
    language = "en-US"


SYSTEM_PROMPT = _build_system_prompt(_NeutralPromptRequest())


async def generate(req: TitlesRequest) -> TitlesResponse:
    start = time.monotonic()
    system_prompt = _build_system_prompt(req)

    hard_character_limit = 100 if req.platform == "YouTube" else 80
    compiled = compile_operation_prompt(OperationPromptInput(
        operation="title_pack",
        topic=req.topic,
        language=req.language,
        creator_profile=creator_profile_block(req),
        source_summary=req.source_summary,
        system_prompt=system_prompt,
        user_instruction=f"Generate {req.count} titles for niche={req.niche}, platform={req.platform}.",
        format_contract=(
            f"Platform: {req.platform}. Operation hard maximum: {hard_character_limit} characters. "
            'Choose title length for clarity, evidence, saved voice, and the supplied topic; do not treat a length range as a ranking rule. '
            'Return a JSON array with title, strategy, score, and why. Sort the bounded creative-review hypotheses by score descending; '
            'the server computes char_count.'
        ),
    ))

    result = await ask_claude_json(
        compiled.prompt,
        system=system_prompt,
        max_tokens=compiled.output_token_budget or 500,
        category="content_engine_titles",
    )
    warnings: list[str] = []
    try:
        titles = validate_model_list(result, TitleVariant, expected_items=req.count)
        if any(title.char_count > hard_character_limit for title in titles):
            raise CreativeOutputContractError("provider_output_invalid")
        if len({" ".join(title.title.casefold().split()) for title in titles}) != len(titles):
            raise CreativeOutputContractError("provider_output_invalid")
        if any(current.score < following.score for current, following in zip(titles, titles[1:])):
            raise CreativeOutputContractError("provider_output_invalid")
        degraded = False
    except CreativeOutputContractError:
        logger.warning("Title provider output failed the bounded response contract")
        titles = []
        degraded = True
        warnings.append(localized_contract_warning(req.language, "titles"))

    duration_ms = int((time.monotonic() - start) * 1000)
    return TitlesResponse(
        topic=req.topic,
        titles=titles,
        duration_ms=duration_ms,
        degraded=degraded,
        warnings=warnings,
        **build_operation_metadata(req, "title_pack", compiled, duration_ms=duration_ms),
    )
