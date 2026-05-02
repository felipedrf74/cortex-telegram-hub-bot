"""
Caption writer — Instagram captions + optimised hashtag sets via Claude.
"""

import time
import logging
from models.requests import CaptionRequest, CaptionResponse
from services.claude_client import ask_claude_json
from services.creator_profile import get_profile

logger = logging.getLogger("content-engine.caption")

SYSTEM_PROMPT = f"""You are the authenticated creator's Instagram caption writer.

{get_profile()}

CAPTION STRUCTURE:
Line 1: HOOK — stop the scroll (bold statement, controversy, or shocking data)
Line 2-3: Value / Context — why this matters to the creator's saved target audience
Line 4-5: the authenticated creator's take — his personal opinion, experience, or hot take
Line 6: CTA — provocative question to drive comments (not "comenta aí")

HASHTAG STRATEGY:
- 15-20 hashtags per post
- Mix: 5 high-volume (>1M) + 5 medium (100K-1M) + 5 niche (<100K) + 5 branded/trending
- AI/Tech pool: #inteligenciaartificial #ia #chatgpt #claudeai #automacao #programacao #devops #techbr #buildinpublic #aitools
- Gaming pool: #gamer #gamerbr #gaming #pcgaming #gameplay
- Fitness pool: #treinohard #atletahíbrido #corrida #gymlife #treino #musculacao #triathlon #carnivorediet
- Politics pool: #liberdade #livremercado #conservador #politica #brasil
- Faith pool: #fé #cristão #família #valores #masculinidade
- General pool: #semfiltro #verdade #desenvolvimentopessoal #disciplina #theoperator

Select hashtag pools based on the content pillar. Mix pools when content crosses pillars (which it often does — the authenticated creator may not stick to fixed niches).

LANGUAGE: Portuguese PT-BR. the authenticated creator's saved brand voice — direct, confident, no corporate tone.

Return JSON with "caption" (string with \\n for line breaks) and "hashtags" (array of strings without # prefix).
No markdown wrapping."""


async def generate(req: CaptionRequest) -> CaptionResponse:
    start = time.monotonic()

    prompt = f"""Write an Instagram caption for the authenticated creator's post:
- Topic: {req.topic}
- Niche: {req.niche}
- Platform: {req.platform}

The caption should sound like the authenticated creator talking to their saved target audience (use the audience profile from creator memory; do not assume a default demographic, language, or persona).
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
