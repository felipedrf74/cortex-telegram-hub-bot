"""
Title A/B tester — generates and scores title variants via Claude.
"""

import time
import logging
from models.requests import TitlesRequest, TitlesResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt

logger = logging.getLogger("content-engine.titles")

def _build_system_prompt(req: TitlesRequest) -> str:
    return f"""You are the creator's YouTube/Instagram title specialist.

{creator_profile_block(req)}

{language_instruction(req)}

STRATEGIES to use (mix them):
- NUMBER: List-driven title with a concrete number
- QUESTION: Question-driven curiosity title
- HOW_TO: "Como [ACHIEVE X] em [TIME]"
- BOLD_CLAIM: Strong but supportable claim
- VS: "[A] vs [B]: Quem Ganha?"
- STORY: First-person experience when appropriate to the creator profile
- CONTROVERSY: Contrarian framing only when topic and creator profile support it
- URGENCY: Timely information gap
- CONTRARIAN: Goes against mainstream — the creator's saved signature style

SCORING (0-100) based on:
- Length: YouTube ideal 50-60 chars, Instagram 30-40
- Power words: CAPITALISE emotional words
- Keyword placement: primary keyword in first 5 words
- Emotional trigger strength
- Brand alignment with the creator configuration above
- Clickability vs deliverability balance

Return ONLY a JSON array. No markdown."""


class _NeutralPromptRequest:
    creator_profile = None
    brand_voice = None
    language = "en-US"


SYSTEM_PROMPT = _build_system_prompt(_NeutralPromptRequest())


async def generate(req: TitlesRequest) -> TitlesResponse:
    start = time.monotonic()

    char_target = "50-60" if req.platform == "YouTube" else "30-40"
    compiled = compile_operation_prompt(OperationPromptInput(
        operation="title_pack",
        topic=req.topic,
        language=req.language,
        creator_profile=creator_profile_block(req),
        user_instruction=f"Generate {req.count} titles for niche={req.niche}, platform={req.platform}.",
        format_contract=(
            f"Platform: {req.platform} (ideal length: {char_target} characters). "
            'Return a JSON array with title, strategy, score, why, and char_count. Sort by score descending.'
        ),
    ))

    result = await ask_claude_json(compiled.prompt, system=_build_system_prompt(req), max_tokens=700)
    titles = result if isinstance(result, list) else [result]

    duration_ms = int((time.monotonic() - start) * 1000)
    return TitlesResponse(
        topic=req.topic,
        titles=titles[:req.count],
        duration_ms=duration_ms,
        **build_operation_metadata(req, "title_pack", compiled),
    )
