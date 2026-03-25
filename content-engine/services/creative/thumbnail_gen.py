"""
Thumbnail concept generator — detailed visual direction for thumbnails via Claude.
"""

import time
import logging
from models.requests import ThumbnailRequest, ThumbnailResponse
from services.claude_client import ask_claude_json
from services.creator_profile import get_profile

logger = logging.getLogger("content-engine.thumbnail")

SYSTEM_PROMPT = f"""You are The Operator's YouTube thumbnail designer.

{get_profile(short=True)}

THE OPERATOR'S BRAND VISUAL IDENTITY:
- AI/Tech builds: Terminal green (#00FF41) on dark background (#0D1117), code overlays, matrix-style accents, screen recordings with glow effects, Claude/API logos subtle in corner
- Reaction/commentary: Webcam-corner overlay style (Asmongold layout), exaggerated facial expressions, content fills background, red/yellow accent text, screenshot overlays with highlight circles
- Training/lifestyle: High contrast, athletic imagery, clean design, bold numbers, suffering faces, carnivore diet aesthetic (raw steak colors — deep reds, warm browns)
- Political/economic: Red/black dramatic tones, data overlays, newspaper/chart screenshots, bold claim text
- Gaming: Neon accents, game UI elements, dark backgrounds, character/logo overlays
- Wild cards: Mix visual elements from relevant pillars — The Operator's brand is the person, not the topic

Each concept must include:
- layout: "split_screen" | "close_up" | "text_heavy" | "before_after" | "reaction_face" | "webcam_corner" | "terminal_screen" | "build_demo"
- background_color: hex color code with rationale
- text_overlay: main text (2-4 words MAX in PT-BR), font style, color, position
- facial_expression: "shocked" | "angry" | "skeptical" | "excited" | "determined" | "deadpan" | "suffering" | "smirk"
- additional_elements: arrows, circles, emojis, charts, screenshots, code snippets, terminal windows, webcam frames, etc.
- why_it_works: psychological explanation for The Operator's audience (men 18-40)

Return ONLY a JSON array of 3 concepts. No markdown."""


async def generate(req: ThumbnailRequest) -> ThumbnailResponse:
    start = time.monotonic()

    prompt = f"""Generate 3 thumbnail concepts for Felipe's video:
- Video title: {req.title}
- Topic: {req.topic or req.title}
- Niche: {req.niche}

Target audience: Portuguese-speaking men 18-40. Thumbnails should convey authority, boldness, and The Operator's unified brand identity.

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
