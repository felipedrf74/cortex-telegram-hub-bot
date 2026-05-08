"""
Thumbnail concept generator — detailed visual direction for thumbnails via Claude.
"""

import time
import logging
from models.requests import ThumbnailRequest, ThumbnailResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction

logger = logging.getLogger("content-engine.thumbnail")

def _build_system_prompt(req: ThumbnailRequest) -> str:
    return f"""You are the authenticated creator's YouTube thumbnail designer.

{creator_profile_block(req)}

{language_instruction(req)}

BRAND VISUAL IDENTITY (use the authenticated creator's saved brand-visual identity from creator memory; the patterns below are setup-safe defaults to use ONLY when the creator has not specified):
- AI/Tech builds: Terminal green (#00FF41) on dark background (#0D1117), code overlays, matrix-style accents, screen recordings with glow effects
- Reaction/commentary: Webcam-corner overlay style, exaggerated facial expressions, content fills background, red/yellow accent text, screenshot overlays with highlight circles
- Training/lifestyle: High contrast, athletic imagery, clean design, bold numbers; only follow a specific dietary aesthetic when the authenticated creator's saved profile explicitly indicates it
- Political/economic: Use the creator's saved political/economic stance from their profile; if unspecified, keep tones neutral
- Gaming: Neon accents, game UI elements, dark backgrounds, character/logo overlays
- Wild cards: Mix visual elements from relevant pillars — the brand is the authenticated creator, not the topic

Each concept must include:
- layout: "split_screen" | "close_up" | "text_heavy" | "before_after" | "reaction_face" | "webcam_corner" | "terminal_screen" | "build_demo"
- background_color: hex color code with rationale
- text_overlay: main text (2-4 words MAX in the requested language), font style, color, position
- facial_expression: "shocked" | "angry" | "skeptical" | "excited" | "determined" | "deadpan" | "suffering" | "smirk"
- additional_elements: arrows, circles, emojis, charts, screenshots, code snippets, terminal windows, webcam frames, etc.
- why_it_works: psychological explanation grounded in the authenticated creator's saved target audience profile (do not assume a default demographic)

Return ONLY a JSON array of 3 concepts. No markdown."""


class _NeutralPromptRequest:
    creator_profile = None
    brand_voice = None
    language = "en-US"


SYSTEM_PROMPT = _build_system_prompt(_NeutralPromptRequest())


async def generate(req: ThumbnailRequest) -> ThumbnailResponse:
    start = time.monotonic()

    prompt = f"""Generate 3 thumbnail concepts for the authenticated creator's video:
- Video title: {req.title}
- Topic: {req.topic or req.title}
- Niche: {req.niche}

Target audience: use the authenticated creator's saved target audience profile (do not assume a default demographic). Thumbnails should convey authority, boldness, and the creator's saved brand identity.

Return JSON array of 3 objects, each with: layout, background_color, text_overlay (object with main_text, font_style, text_color, position), facial_expression, additional_elements (array), why_it_works.

Rank by predicted CTR (best first)."""

    result = await ask_claude_json(prompt, system=_build_system_prompt(req))
    concepts = result if isinstance(result, list) else [result]

    duration_ms = int((time.monotonic() - start) * 1000)
    return ThumbnailResponse(
        title=req.title,
        concepts=concepts[:3],
        duration_ms=duration_ms,
    )
