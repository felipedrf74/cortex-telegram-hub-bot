"""
Title A/B tester — generates and scores title variants via Claude.
"""

import time
import logging
from models.requests import TitlesRequest, TitlesResponse
from services.claude_client import ask_claude_json
from services.creator_profile import get_profile

logger = logging.getLogger("content-engine.titles")

SYSTEM_PROMPT = f"""You are the creator's YouTube/Instagram title specialist.

{get_profile(short=True)}

STRATEGIES to use (mix them):
- NUMBER: "5 Razões para..." / "3 Erros que..."
- QUESTION: "Por que [TOPIC] está..." / "Será que funciona?"
- HOW_TO: "Como [ACHIEVE X] em [TIME]"
- BOLD_CLAIM: "[TOPIC] Está MORTO" / "A Verdade sobre..."
- VS: "[A] vs [B]: Quem Ganha?"
- STORY: "Eu Testei [TOPIC] por [TIME] e..."
- CONTROVERSY: "PAREI de [THING] e Isto Aconteceu"
- URGENCY: "O Que NINGUÉM Está a Dizer"
- CONTRARIAN: Goes against mainstream — Felipe's signature

SCORING (0-100) based on:
- Length: YouTube ideal 50-60 chars, Instagram 30-40
- Power words: CAPITALISE emotional words
- Keyword placement: primary keyword in first 5 words
- Emotional trigger strength
- Brand alignment with the creator configuration above
- Clickability vs deliverability balance

Return ONLY a JSON array. No markdown."""


async def generate(req: TitlesRequest) -> TitlesResponse:
    start = time.monotonic()

    char_target = "50-60" if req.platform == "YouTube" else "30-40"
    prompt = f"""Generate {req.count} title variants for Felipe's channel:
- Topic: {req.topic}
- Niche: {req.niche}
- Platform: {req.platform} (ideal length: {char_target} characters)

Titles should sound like Felipe — direct, bold, no-BS. His audience is Brazilian men 18-35.
Titles should stay grounded in the actual topic. Do NOT force politics, training, or reaction framing when the topic points somewhere else.

Return JSON array where each object has:
- "title": the title in PT-BR
- "strategy": which strategy was used
- "score": 0-100 effectiveness score
- "why": one sentence on why it works for Felipe's audience
- "char_count": number of characters

Sort by score descending."""

    result = await ask_claude_json(prompt, system=SYSTEM_PROMPT)
    titles = result if isinstance(result, list) else [result]

    duration_ms = int((time.monotonic() - start) * 1000)
    return TitlesResponse(
        topic=req.topic,
        titles=titles[:req.count],
        duration_ms=duration_ms,
    )
