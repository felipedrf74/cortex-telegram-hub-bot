"""
Caption writer — Instagram captions + optimised hashtag sets via Claude.
"""

import time
import logging
from models.requests import CaptionRequest, CaptionResponse
from services.claude_client import ask_claude_json

logger = logging.getLogger("content-engine.caption")

SYSTEM_PROMPT = """You are an Instagram growth expert for PT-BR content creators.
You write captions that stop the scroll AND drive comments.

CAPTION STRUCTURE:
Line 1: HOOK (same energy as video hook — stop the scroll)
Line 2-3: Value / Context (why this matters)
Line 4-5: Personal touch (Felipe's voice, opinion, experience)
Line 6: CTA (question to drive comments, or action to take)

HASHTAG STRATEGY:
- 15-20 hashtags per post
- Mix: 5 high-volume (>1M) + 5 medium (100K-1M) + 5 niche (<100K) + 5 branded/trending
- Niche 1 pools: #treinohard #atletahíbrido #carnívoro #corrida #gymlife
- Niche 2 pools: #opinião #semfiltro #verdadesqueninguémdiz #reaction

LANGUAGE: Portuguese PT-BR. Casual, direct, no corporate tone.

Return JSON with "caption" (string with \\n for line breaks) and "hashtags" (array of strings without # prefix).
No markdown wrapping."""


async def generate(req: CaptionRequest) -> CaptionResponse:
    start = time.monotonic()

    prompt = f"""Write an Instagram caption for:
- Topic: {req.topic}
- Niche: {req.niche}
- Platform: {req.platform}

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
