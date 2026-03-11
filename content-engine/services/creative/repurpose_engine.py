"""
Repurpose engine — turn 1 content piece into a full content ecosystem via Claude.

1 YouTube video → 3 Reels + 1 Carousel + 5 Stories + 3 Tweets + 2 Community Posts
"""

import time
import logging
from models.requests import RepurposeRequest, RepurposeResponse
from services.claude_client import ask_claude_json

logger = logging.getLogger("content-engine.repurpose")

SYSTEM_PROMPT = """You are a content atomization expert for PT-BR creators.
You turn 1 content piece into a full multi-platform ecosystem.

From 1 YouTube video, generate:
- 3 Reels/Shorts (15-60s): best moments, key stats, hot takes
- 1 Carousel (8-10 slides): visual summary of key points
- 5 Stories: behind the scenes, poll, quote, stat, CTA
- 3 Tweets: hot take, stat/quote, engagement question
- 2 Community Posts: poll + teaser

For each output provide:
- format: Reel/Short/Carousel/Story/Tweet/CommunityPost
- platform: YouTube/Instagram/Twitter
- content: the specific text/description
- posting_delay: when to post relative to main video (e.g. "+2h", "+1d", "+3d")
- notes: platform-specific adjustments

Return ONLY a JSON array of objects. No markdown. Language: PT-BR."""


async def generate(req: RepurposeRequest) -> RepurposeResponse:
    start = time.monotonic()

    prompt = f"""Create a content atomization plan for:
- Topic: {req.topic}
- Original format: {req.original_format}

Generate the full ecosystem: 3 Reels, 1 Carousel, 5 Stories, 3 Tweets, 2 Community Posts.
Return JSON array of objects with: format, platform, content, posting_delay, notes."""

    result = await ask_claude_json(prompt, system=SYSTEM_PROMPT, max_tokens=6000)
    outputs = result if isinstance(result, list) else [result]

    duration_ms = int((time.monotonic() - start) * 1000)
    return RepurposeResponse(
        topic=req.topic,
        outputs=outputs,
        duration_ms=duration_ms,
    )
