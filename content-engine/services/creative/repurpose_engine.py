"""
Repurpose engine — turn 1 content piece into a full content ecosystem via Claude.

1 YouTube video → 3 Reels + 1 Carousel + 5 Stories + 3 Tweets + 2 Community Posts
"""

import time
import logging
from models.requests import RepurposeRequest, RepurposeResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt

logger = logging.getLogger("content-engine.repurpose")

def _build_system_prompt(req: RepurposeRequest) -> str:
    return f"""You are the authenticated creator's content atomization strategist.

{creator_profile_block(req)}

{language_instruction(req)}

You turn 1 content piece into a full multi-platform ecosystem, all in the authenticated creator's saved brand voice.

From 1 YouTube video, generate:
- 3 Reels/Shorts (15-60s): most controversial moments, key data, hot takes
- 1 Carousel (8-10 slides): visual summary with the creator's saved opinions and stances highlighted
- 5 Stories: behind the scenes, poll (controversial question), quote, stat, CTA
- 3 Tweets: contrarian hot take, data/stat that shocks, engagement question
- 2 Community Posts: poll (divisive topic) + teaser

SFX DENSITY RULES:
- Shorts/Reels (15-60s): 3-5 [SFX:...] markers per 60 seconds. Dense, punchy, meme-heavy.
- YouTube long-form: 2-3 [SFX:...] markers per minute. Strategic, not overwhelming.
- All repurposed video content MUST include [SFX:...] and [EDIT:...] markers.

AVAILABLE MARKERS:
- [SFX:vine-boom] [SFX:metal-pipe] [SFX:fahhh] [SFX:bruh] [SFX:sad-violin] [SFX:among-us] [SFX:record-scratch] [SFX:ding] [SFX:boom]
- [EDIT:zoom-punch] [EDIT:hard-cut] [EDIT:speed-ramp] [EDIT:text-popup] [EDIT:deadpan-stare]

For each output provide:
- format: Reel/Short/Carousel/Story/Tweet/CommunityPost
- platform: YouTube/Instagram/Twitter
- content: the specific text/description in the requested language and authenticated creator's saved brand voice. For Reels/Shorts, include [SFX:...] and [EDIT:...] markers inline.
- posting_delay: when to post relative to main video (e.g. "+2h", "+1d", "+3d")
- notes: platform-specific adjustments + SFX/edit notes for video content

IMPORTANT: All content must reflect the creator's saved brand voice and worldview and unified identity. Tweets should be provocative.
Reels should open with [SFX:vine-boom] or [SFX:metal-pipe] on the most controversial or data-shocking moment.
Shorts need [EDIT:zoom-punch] on reaction faces and [EDIT:hard-cut] between segments.
Community polls should spark debate.

Return ONLY a JSON array of objects. No markdown."""


class _NeutralPromptRequest:
    creator_profile = None
    brand_voice = None
    language = "en-US"


SYSTEM_PROMPT = _build_system_prompt(_NeutralPromptRequest())


async def generate(req: RepurposeRequest) -> RepurposeResponse:
    start = time.monotonic()

    compiled = compile_operation_prompt(OperationPromptInput(
        operation="repurpose",
        topic=req.topic,
        language=req.language,
        creator_profile=creator_profile_block(req),
        user_instruction=f"- Original format: {req.original_format}",
        format_contract=(
            'Generate a compact ecosystem: 3 Reels, 1 Carousel, 3 Stories, 2 Tweets, 1 Community Post. '
            'Return JSON array with format, platform, content, posting_delay, notes.'
        ),
    ))

    # 2026-05-18 phase2-qa P2: align model output cap with the documented
    # operation budget. `OPERATION_BUDGETS["repurpose"] = ("quick", 1900)`
    # but this call previously sent max_tokens=2200 — a 16% honesty gap
    # between the budget metadata iOS sees and what the model is allowed to
    # emit. Use the same number both places.
    result = await ask_claude_json(compiled.prompt, system=_build_system_prompt(req), max_tokens=1900)
    outputs = result if isinstance(result, list) else [result]

    duration_ms = int((time.monotonic() - start) * 1000)
    return RepurposeResponse(
        topic=req.topic,
        outputs=outputs,
        duration_ms=duration_ms,
        **build_operation_metadata(req, "repurpose", compiled),
    )
