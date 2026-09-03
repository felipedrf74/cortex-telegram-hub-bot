"""Repurpose engine — propose a bounded set of useful content derivatives."""

import time
import logging
import re
from models.requests import RepurposeOutput, RepurposeRequest, RepurposeResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt
from services.creative.output_contracts import (
    CreativeOutputContractError,
    localized_contract_warning,
    validate_bounded_model_list,
)

logger = logging.getLogger("content-engine.repurpose")

ALLOWED_EDIT_MARKERS = {"HARD-CUT", "GENTLE-CUT", "CROP", "TEXT-POPUP", "SOURCE-INSERT", "DIAGRAM"}
ALLOWED_SFX_MARKERS = {"IMPACT", "TRANSITION", "NOTIFICATION", "AMBIENT", "NONE"}

def _build_system_prompt(req: RepurposeRequest) -> str:
    return f"""You are the authenticated creator's content atomization strategist.

{creator_profile_block(req)}

{language_instruction(req)}

You turn one content piece into a bounded set of useful derivatives in the authenticated creator's saved brand voice.

From the supplied {req.original_format} content, generate one to ten distinct derivative proposals. Select only formats that fit the source, requested language, saved creator voice, and supported claims; do not fill a platform quota. Permitted canonical format/platform pairs are:
- Reel / Instagram
- Short / YouTube
- Carousel / Instagram
- Story / Instagram
- Tweet / Twitter
- CommunityPost / YouTube

EDITING MARKER RULES:
- Include [EDIT:...] markers where a cut, crop, caption, insert, or visual transition materially improves comprehension.
- Include [SFX:...] only when the authenticated creator's saved style and the topic support sound design; use [SFX:none] when restraint is the better fit.
- Do not impose meme-heavy pacing, reaction editing, a fixed sound-effect density, or a provocative persona unless the saved voice explicitly calls for it.

AVAILABLE MARKERS:
- [SFX:impact] [SFX:transition] [SFX:notification] [SFX:ambient] [SFX:none]
- [EDIT:hard-cut] [EDIT:gentle-cut] [EDIT:crop] [EDIT:text-popup] [EDIT:source-insert] [EDIT:diagram]

For each output provide:
- format: Reel/Short/Carousel/Story/Tweet/CommunityPost
- platform: YouTube/Instagram/Twitter
- content: the specific text/description in the requested language and authenticated creator's saved brand voice. For video content, include appropriate [EDIT:...] and [SFX:...] or [SFX:none] markers inline.
- posting_delay: return "unspecified". This request has no authorized cadence control, and the field is proposal metadata rather than a schedule or publication instruction.
- notes: platform-specific adjustments + SFX/edit notes for video content

IMPORTANT: All content must reflect the creator's saved brand voice and unified identity. Never force provocation, controversy, divisiveness, personal experience, or a worldview that is absent from the authenticated profile and request. Every derivative must preserve the original content's supported claims and intent. Treat format selection, ordering, and any future cadence as reviewable hypotheses, never platform rules or execution receipts.

Return ONLY a JSON array of objects. No markdown."""


class _NeutralPromptRequest:
    creator_profile = None
    brand_voice = None
    language = "en-US"
    original_format = "source"


SYSTEM_PROMPT = _build_system_prompt(_NeutralPromptRequest())


def _normalized_token(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


def _reconcile_output_distribution(outputs: list[RepurposeOutput]) -> list[RepurposeOutput]:
    """Canonicalize known labels and reject invalid bounded derivative sets.

    The function name is retained for compatibility with focused fixtures and
    internal imports. It no longer enforces a platform/content quota.
    """
    if not 1 <= len(outputs) <= 10:
        raise CreativeOutputContractError("provider_output_invalid")
    canonical_outputs: list[RepurposeOutput] = []
    format_aliases = {
        "reel": "Reel",
        "reels": "Reel",
        "short": "Short",
        "shorts": "Short",
        "youtubeshort": "Short",
        "youtubeshorts": "Short",
        "carousel": "Carousel",
        "carousels": "Carousel",
        "story": "Story",
        "stories": "Story",
        "tweet": "Tweet",
        "tweets": "Tweet",
        "communitypost": "CommunityPost",
        "communityposts": "CommunityPost",
    }
    platform_aliases = {
        "instagram": "Instagram",
        "youtube": "YouTube",
        "twitter": "Twitter",
        "x": "Twitter",
    }
    expected_platform = {
        "Reel": "Instagram",
        "Short": "YouTube",
        "Carousel": "Instagram",
        "Story": "Instagram",
        "Tweet": "Twitter",
        "CommunityPost": "YouTube",
    }

    for output in outputs:
        format_token = _normalized_token(output.format)
        platform = platform_aliases.get(_normalized_token(output.platform))
        if format_token in {"reelshort", "reelsshorts", "reelorshort", "reelsorshorts"}:
            content_format = "Reel" if platform == "Instagram" else "Short" if platform == "YouTube" else None
        else:
            content_format = format_aliases.get(format_token)
        if content_format is None or platform != expected_platform[content_format]:
            raise CreativeOutputContractError("provider_output_invalid")
        marker_text = output.content.upper()
        # Treat every bracketed uppercase token as marker-like, including
        # malformed forms such as `[EDIT text-popup]` and `[CUT hard]` that do
        # not contain a colon. A marker-like token is valid only when it maps
        # one-to-one to a complete allowlisted EDIT/SFX marker below.
        marker_prefixes = re.findall(r"\[([A-Z][A-Z0-9_-]*)\b", marker_text)
        complete_markers = re.findall(r"\[([A-Z][A-Z0-9_-]*):([A-Z-]+)\]", marker_text)
        edit_markers = [value for marker_type, value in complete_markers if marker_type == "EDIT"]
        sfx_markers = [value for marker_type, value in complete_markers if marker_type == "SFX"]
        if (
            len(marker_prefixes) != len(complete_markers)
            or any(marker_type not in {"EDIT", "SFX"} for marker_type in marker_prefixes)
            or any(marker not in ALLOWED_EDIT_MARKERS for marker in edit_markers)
            or any(marker not in ALLOWED_SFX_MARKERS for marker in sfx_markers)
            or (content_format in {"Reel", "Short"} and (not edit_markers or not sfx_markers))
        ):
            raise CreativeOutputContractError("provider_output_invalid")
        canonical_outputs.append(output.model_copy(update={"format": content_format, "platform": platform}))

    if len({" ".join(item.content.casefold().split()) for item in canonical_outputs}) != len(canonical_outputs):
        raise CreativeOutputContractError("provider_output_invalid")
    return canonical_outputs


async def generate(req: RepurposeRequest) -> RepurposeResponse:
    start = time.monotonic()
    system_prompt = _build_system_prompt(req)

    compiled = compile_operation_prompt(OperationPromptInput(
        operation="repurpose",
        topic=req.topic,
        language=req.language,
        creator_profile=creator_profile_block(req),
        source_summary=req.source_summary,
        system_prompt=system_prompt,
        draft_context=f"Source content to atomize:\n{req.source_content}",
        user_instruction=f"- Original format: {req.original_format}",
        format_contract=(
            'Return one to ten useful, non-duplicate derivative proposals using only the canonical format/platform pairs. '
            'Do not fill a format quota. Return JSON array with format, platform, content, posting_delay, notes; '
            'posting_delay must be "unspecified" because this request supplies no cadence evidence.'
        ),
    ))

    result = await ask_claude_json(
        compiled.prompt,
        system=system_prompt,
        max_tokens=compiled.output_token_budget or 1800,
        category="content_engine_repurpose",
    )
    warnings: list[str] = []
    try:
        outputs = _reconcile_output_distribution(
            validate_bounded_model_list(
                result,
                RepurposeOutput,
                min_items=1,
                max_items=10,
            )
        )
        degraded = False
    except CreativeOutputContractError:
        logger.warning("Repurpose provider output failed the bounded response contract")
        outputs = []
        degraded = True
        warnings.append(localized_contract_warning(req.language, "repurposed outputs"))

    duration_ms = int((time.monotonic() - start) * 1000)
    return RepurposeResponse(
        topic=req.topic,
        outputs=outputs,
        duration_ms=duration_ms,
        degraded=degraded,
        warnings=warnings,
        **build_operation_metadata(
            req,
            "repurpose",
            compiled,
            artifacts_reused=bool(req.source_package_id and req.source_summary),
            duration_ms=duration_ms,
        ),
    )
