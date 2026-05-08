"""
Title A/B tester — generates and scores title variants via Claude.
"""

import time
import logging
from models.requests import TitlesRequest, TitlesResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction

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
    prompt = f"""Generate {req.count} title variants for the authenticated creator's channel:
- Topic: {req.topic}
- Niche: {req.niche}
- Platform: {req.platform} (ideal length: {char_target} characters)

Titles should sound in the authenticated creator's saved brand voice and tone. Audience: use the creator's saved target audience profile from creator memory (do not assume a default demographic).
Titles should stay grounded in the actual topic. Do NOT force politics, training, or reaction framing when the topic points somewhere else.

Return JSON array where each object has:
- "title": the title in the requested language
- "strategy": which strategy was used
- "score": 0-100 effectiveness score
- "why": one sentence on why it works for the creator's saved target audience
- "char_count": number of characters

Sort by score descending."""

    result = await ask_claude_json(prompt, system=_build_system_prompt(req))
    titles = result if isinstance(result, list) else [result]

    duration_ms = int((time.monotonic() - start) * 1000)
    return TitlesResponse(
        topic=req.topic,
        titles=titles[:req.count],
        duration_ms=duration_ms,
    )
