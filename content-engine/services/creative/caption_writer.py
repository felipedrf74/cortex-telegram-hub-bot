"""
Caption writer — Instagram captions + optimised hashtag sets via Claude.

IDENTITY-SAFETY CONTRACT (closed-beta v4.14.126+):
The SYSTEM_PROMPT is computed per request from the authenticated creator's
profile. It MUST NOT carry hardcoded political, religious, dietary,
ideological, or branded hashtag pools, and MUST NOT
hardcode the output language. The hashtag strategy is purely structural
(volume tiers + creator-pillar-driven). Language defaults to the creator's
saved `primary_content_language` when present; otherwise the model is
instructed to mirror the input topic's language.

Regression context: v4.14.118 closed the markdown-prompt leaks for
`secretary.md` / `content.md` / etc., and `script_writer.py` was migrated
to a per-request creator block. caption_writer.py was missed in that pass
and continued to inject founder-shaped worldview and dietary
hashtag pools plus a hardcoded language override into every
authenticated user's caption generation. The closed-beta hardening pass
(2026-05-03) sanitized this file to the same per-request creator-block
pattern; this file now reads that block from the request.
"""

import time
import logging
from models.requests import CaptionRequest, CaptionResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt

logger = logging.getLogger("content-engine.caption")


def _build_system_prompt(creator_block: str) -> str:
    """Build the system prompt from the per-request creator profile.

    The creator_block carries the authenticated creator's worldview,
    audience, voice, language defaults, and pillar/hashtag preferences
    (when saved). The prompt itself contains NO ideology, dietary,
    political, or branded vocabulary — only structural guidance about
    caption shape and hashtag tiering.
    """
    return f"""You are the authenticated creator's Instagram caption writer.

{creator_block}

CAPTION STRUCTURE:
Line 1: HOOK — stop the scroll (bold statement, controversy, or shocking data) in the creator's saved voice
Line 2-3: Value / Context — why this matters to the creator's saved target audience
Line 4-5: the authenticated creator's take — their personal opinion, experience, or hot take, in their saved voice
Line 6: CTA — provocative question to drive comments (do NOT use generic phrasing like "comment below")

HASHTAG STRATEGY (structural — do not invent ideological, political, religious, or dietary tags):
- 15-20 hashtags per post.
- Mix volume tiers: ~5 high-volume (>1M posts) + ~5 medium (100K–1M) + ~5 niche (<100K) + ~5 trending/branded.
- Pull niche/branded tags ONLY from the creator's saved pillars and tag library in the creator profile above.
- If the creator profile does not list a relevant tag for a pillar, omit it rather than fabricating one.
- Do NOT inject worldview, dietary, or persona hashtags that are not present in the creator's saved configuration.

LANGUAGE:
- Use the creator's saved `primary_content_language` from the creator profile above when present.
- If unspecified, mirror the language of the supplied TOPIC.
- Match the creator's saved brand voice — direct or measured, opinionated or neutral, formal or casual — exactly as configured. Do NOT default to a single voice archetype.

Return JSON with "caption" (string with \\n for line breaks) and "hashtags" (array of strings without # prefix).
No markdown wrapping."""


async def generate(req: CaptionRequest) -> CaptionResponse:
    start = time.monotonic()

    creator_block = creator_profile_block(req)
    system_prompt = _build_system_prompt(creator_block)

    compiled = compile_operation_prompt(OperationPromptInput(
        operation="caption_pack",
        topic=req.topic,
        language=req.language,
        creator_profile=creator_block,
        user_instruction=f"Write for niche={req.niche}, platform={req.platform}.",
        format_contract='Return JSON with caption and hashtags. Include 15-20 hashtags. Caption should be 5-7 lines.',
    ))

    result = await ask_claude_json(compiled.prompt, system=system_prompt, max_tokens=850)
    caption = result.get("caption", "") if isinstance(result, dict) else ""
    hashtags = result.get("hashtags", []) if isinstance(result, dict) else []

    duration_ms = int((time.monotonic() - start) * 1000)
    return CaptionResponse(
        topic=req.topic,
        caption=caption,
        hashtags=hashtags,
        duration_ms=duration_ms,
        **build_operation_metadata(req, "caption_pack", compiled),
    )
