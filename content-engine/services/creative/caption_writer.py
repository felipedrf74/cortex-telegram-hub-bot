"""
Caption writer — Instagram captions + optional topic-grounded hashtag sets.

IDENTITY-SAFETY CONTRACT (closed-beta v4.14.126+):
The SYSTEM_PROMPT is computed per request from the authenticated creator's
profile. It MUST NOT carry hardcoded political, religious, dietary,
ideological, or branded hashtag pools, and MUST NOT
hardcode the output language. The hashtag strategy is purely structural and
creator-pillar-driven. The explicit request language is authoritative; saved
profile language may inform voice examples but cannot override it.

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
from models.requests import CaptionGenerationPayload, CaptionRequest, CaptionResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt
from services.creative.output_contracts import CreativeOutputContractError, localized_contract_warning, validate_model_object

logger = logging.getLogger("content-engine.caption")


def _build_system_prompt(creator_block: str, language: str = "en-US") -> str:
    """Build the system prompt from the per-request creator profile.

    The creator_block carries the authenticated creator's worldview,
    audience, voice examples, and pillar/hashtag preferences
    (when saved). The prompt itself contains NO ideology, dietary,
    political, or branded vocabulary — only structural guidance about
    caption and optional hashtag selection.
    """
    return f"""You are the authenticated creator's Instagram caption writer.

{creator_block}

CAPTION OPTIONS (choose only what fits the request, topic, and saved voice):
- A topic-grounded opening, relevant context, explanation, creator commentary, proof cue, or next action may be used in any clear order.
- Use personal opinion or experience only when the authenticated profile or request provides it.
- A CTA and line breaks are optional. Do not pad the caption, force engagement bait, or impose a universal line count.

HASHTAG SELECTION (structural — do not invent trend or volume evidence):
- Return zero to 20 unique, topic-relevant hashtags without the # prefix. An empty list is valid when no hashtag is justified by the topic or saved profile.
- Prefer precise terms grounded in the supplied topic and authenticated creator's saved pillars.
- Pull branded tags ONLY from the creator's saved tag library in the creator profile above.
- Do not label or select a tag as high-volume, trending, or branded unless supplied evidence or the saved profile establishes that status.
- Do NOT inject worldview, dietary, political, religious, or persona hashtags that are not present in the creator's saved configuration.

LANGUAGE:
- Render the full caption and hashtags in the request-authoritative language `{language}`.
- A saved profile language may inform voice examples but must not override this operation's explicit language.
- Match the creator's saved brand voice — direct or measured, opinionated or neutral, formal or casual — exactly as configured. Do NOT default to a single voice archetype.

Return JSON with "caption" (string with \\n for line breaks) and "hashtags" (array of strings without # prefix).
No markdown wrapping."""


async def generate(req: CaptionRequest) -> CaptionResponse:
    start = time.monotonic()

    creator_block = creator_profile_block(req)
    system_prompt = _build_system_prompt(creator_block, req.language)

    compiled = compile_operation_prompt(OperationPromptInput(
        operation="caption_pack",
        topic=req.topic,
        language=req.language,
        creator_profile=creator_block,
        source_summary=req.source_summary,
        system_prompt=system_prompt,
        user_instruction=f"Write for niche={req.niche}, platform={req.platform}.",
        format_contract=(
            'Return JSON with caption and zero to 20 unique hashtags. Choose caption structure and line breaks from the request and saved voice; '
            'do not add a CTA or hashtags merely to satisfy a quota.'
        ),
    ))

    result = await ask_claude_json(
        compiled.prompt,
        system=system_prompt,
        max_tokens=compiled.output_token_budget or 700,
        category="content_engine_caption",
    )
    warnings: list[str] = []
    try:
        payload = validate_model_object(result, CaptionGenerationPayload)
        caption = payload.caption
        hashtags = payload.hashtags
        degraded = False
    except CreativeOutputContractError:
        logger.warning("Caption provider output failed the bounded response contract")
        caption = ""
        hashtags = []
        degraded = True
        warnings.append(localized_contract_warning(req.language, "caption"))

    duration_ms = int((time.monotonic() - start) * 1000)
    return CaptionResponse(
        topic=req.topic,
        caption=caption,
        hashtags=hashtags,
        duration_ms=duration_ms,
        degraded=degraded,
        warnings=warnings,
        **build_operation_metadata(req, "caption_pack", compiled, duration_ms=duration_ms),
    )
