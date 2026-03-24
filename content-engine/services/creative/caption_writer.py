"""
Caption writer — Instagram captions + optimised hashtag sets via Claude.
"""

import time
import logging
from models.requests import CaptionRequest, CaptionResponse
from services.claude_client import ask_claude_json
from services.creator_profile import get_profile

logger = logging.getLogger("content-engine.caption")

SYSTEM_PROMPT = f"""You are Felipe's Instagram caption writer.

{get_profile()}

CAPTION STRUCTURE:
Line 1: HOOK — stop the scroll (bold statement, controversy, or shocking data)
Line 2-3: Value / Context — why this matters to a young Brazilian man
Line 4-5: Felipe's take — his personal opinion, experience, or hot take
Line 6: CTA — provocative question to drive comments (not "comenta aí")

HASHTAG STRATEGY:
- 15-20 hashtags per post
- Mix: 5 high-volume (>1M) + 5 medium (100K-1M) + 5 niche (<100K) + 5 branded/trending
- Fitness pool: #treinohard #atletahíbrido #corrida #gymlife #treino #musculacao
- Politics pool: #liberdade #livremercado #conservador #politica #brasil
- Faith pool: #fé #cristão #família #valores #masculinidade
- General pool: #semfiltro #verdade #desenvolvimentopessoal #disciplina

LANGUAGE: Portuguese PT-BR. Felipe's voice — direct, confident, no corporate tone.

Return JSON with "caption" (string with \\n for line breaks) and "hashtags" (array of strings without # prefix).
No markdown wrapping."""


async def generate(req: CaptionRequest) -> CaptionResponse:
    start = time.monotonic()

    prompt = f"""Write an Instagram caption for Felipe's post:
- Topic: {req.topic}
- Niche: {req.niche}
- Platform: {req.platform}

The caption should sound like Felipe talking to his audience (Brazilian men 18-35).
Be direct, opinionated, and end with a question that sparks debate.

Return JSON: {{"caption": "...", "hashtags": ["tag1", "tag2", ...]}}
Include 15-20 hashtags. Caption should be 5-7 lines."""

    result = await ask_claude_json(prompt, system=SYSTEM_PROMPT)
    caption = result.get("caption", "") if isinstance(result, dict) else ""
    hashtags = result.get("hashtags", []) if isinstance(result, dict) else []

    duration_ms = int((time.monotonic() - start) * 1000)
    return CaptionResponse(
        topic=req.topic,
        caption=caption,
        hashtags=hashtags,
        duration_ms=duration_ms,
    )
