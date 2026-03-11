"""
Thumbnail concept generator — detailed visual direction for thumbnails via Claude.
"""

import time
import logging
from models.requests import ThumbnailRequest, ThumbnailResponse
from services.claude_client import ask_claude_json

logger = logging.getLogger("content-engine.thumbnail")

SYSTEM_PROMPT = """You are a YouTube thumbnail design expert for PT-BR content creators.
Generate detailed thumbnail concepts with visual direction.

NICHE DEFAULTS:
- Fitness/hybrid athlete: High contrast, athletic imagery, clean design, bold numbers
- Commentary/reaction: Reaction faces, red/yellow accents, dramatic text, screenshot overlays

Each concept must include:
- layout: "split_screen" | "close_up" | "text_heavy" | "before_after" | "reaction_face"
- background_color: hex color code with rationale
- text_overlay: main text (2-4 words MAX), font style, color, position
- facial_expression: "shocked" | "angry" | "skeptical" | "excited" | "determined"
- additional_elements: arrows, circles, emojis, etc.
- why_it_works: psychological explanation

Return ONLY a JSON array of 3 concepts. No markdown."""


async def generate(req: ThumbnailRequest) -> ThumbnailResponse:
    start = time.monotonic()

    prompt = f"""Generate 3 thumbnail concepts for:
- Video title: {req.title}
- Topic: {req.topic or req.title}
- Niche: {req.niche}

Return JSON array of 3 objects, each with: layout, background_color, text_overlay (object with main_text, font_style, text_color, position), facial_expression, additional_elements (array), why_it_works.

Rank by predicted CTR (best first)."""

    result = await ask_claude_json(prompt, system=SYSTEM_PROMPT)
    concepts = result if isinstance(result, list) else [result]

    duration_ms = int((time.monotonic() - start) * 1000)
    return ThumbnailResponse(
        title=req.title,
        concepts=concepts[:3],
        duration_ms=duration_ms,
    )
