"""
Thumbnail concept generator — detailed visual direction for thumbnails via Claude.
"""

import time
import logging
from models.requests import ThumbnailRequest, ThumbnailResponse
from services.claude_client import ask_claude_json
from services.creator_profile import get_profile

logger = logging.getLogger("content-engine.thumbnail")

SYSTEM_PROMPT = f"""You are Felipe's YouTube thumbnail designer.

{get_profile(short=True)}

FELIPE'S BRAND VISUAL IDENTITY:
- Fitness content: High contrast, athletic imagery, clean design, bold numbers, strong physique
- Political/economic content: Red/black dramatic tones, data overlays, newspaper/chart screenshots
- Faith/values: Warm tones, family imagery, clean and serious — not preachy
- Reaction/commentary: Reaction faces, red/yellow accents, dramatic text, screenshot overlays

Each concept must include:
- layout: "split_screen" | "close_up" | "text_heavy" | "before_after" | "reaction_face"
- background_color: hex color code with rationale
- text_overlay: main text (2-4 words MAX in PT-BR), font style, color, position
- facial_expression: "shocked" | "angry" | "skeptical" | "excited" | "determined"
- additional_elements: arrows, circles, emojis, charts, screenshots, etc.
- why_it_works: psychological explanation for Felipe's audience (men 18-35)

Return ONLY a JSON array of 3 concepts. No markdown."""


async def generate(req: ThumbnailRequest) -> ThumbnailResponse:
    start = time.monotonic()

    prompt = f"""Generate 3 thumbnail concepts for Felipe's video:
- Video title: {req.title}
- Topic: {req.topic or req.title}
- Niche: {req.niche}

Target audience: Brazilian men 18-35. Thumbnails should convey authority, boldness, and Felipe's no-BS brand.

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
