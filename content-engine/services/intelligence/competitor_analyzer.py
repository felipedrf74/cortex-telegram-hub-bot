"""
Competitor analyzer — reverse-engineer top creators via YouTube API + Claude analysis.

Analyses: title patterns, upload frequency, content mix, engagement patterns.
"""

import time
import logging

import httpx

from config import cfg
from models.requests import CompetitorRequest, CompetitorResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt

logger = logging.getLogger("content-engine.competitor")

YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
YT_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"


async def _fetch_channel_videos(channel_query: str, max_videos: int) -> list[dict]:
    """Fetch recent videos from a channel (by name/URL search)."""
    if not cfg.youtube_api_key:
        return []

    async with httpx.AsyncClient(timeout=15) as client:
        # Search for the channel
        ch_params = {
            "part": "snippet",
            "q": channel_query,
            "type": "channel",
            "maxResults": 1,
            "key": cfg.youtube_api_key,
        }
        ch_resp = await client.get(YT_SEARCH_URL, params=ch_params)
        ch_resp.raise_for_status()
        ch_items = ch_resp.json().get("items", [])
        if not ch_items:
            return []

        channel_id = ch_items[0]["id"].get("channelId", "")
        channel_title = ch_items[0]["snippet"].get("channelTitle", channel_query)

        # Get recent videos from channel
        vid_params = {
            "part": "snippet",
            "channelId": channel_id,
            "type": "video",
            "order": "date",
            "maxResults": min(max_videos, 20),
            "key": cfg.youtube_api_key,
        }
        vid_resp = await client.get(YT_SEARCH_URL, params=vid_params)
        vid_resp.raise_for_status()
        vid_items = vid_resp.json().get("items", [])

        # Get stats for these videos
        video_ids = [v["id"].get("videoId", "") for v in vid_items if v.get("id", {}).get("videoId")]
        if not video_ids:
            return []

        stats_params = {
            "part": "statistics,contentDetails",
            "id": ",".join(video_ids),
            "key": cfg.youtube_api_key,
        }
        stats_resp = await client.get(YT_VIDEOS_URL, params=stats_params)
        stats_resp.raise_for_status()
        stats_map = {v["id"]: v for v in stats_resp.json().get("items", [])}

    videos = []
    for item in vid_items:
        vid_id = item["id"].get("videoId", "")
        snippet = item.get("snippet", {})
        stats = stats_map.get(vid_id, {}).get("statistics", {})
        videos.append({
            "title": snippet.get("title", ""),
            "published_at": snippet.get("publishedAt", ""),
            "views": int(stats.get("viewCount", 0)),
            "likes": int(stats.get("likeCount", 0)),
            "comments": int(stats.get("commentCount", 0)),
            "channel": channel_title,
        })

    return videos


async def analyze(req: CompetitorRequest) -> CompetitorResponse:
    start = time.monotonic()
    system_prompt = f"""You are the authenticated creator's competitor intelligence analyst.

{creator_profile_block(req)}

{language_instruction(req)}

Use the creator profile only to tailor useful, scoped recommendations. Do not assume ideology, language, audience, belief system, diet, nationality, or founder persona when it is not supplied."""

    videos = await _fetch_channel_videos(req.channel, req.max_videos)

    video_summary = [
        f"{v['title']} | {v['views']:,} views | {v['likes']:,} likes | {v['published_at'][:10]}"
        for v in videos[:12]
    ]
    compiled = compile_operation_prompt(OperationPromptInput(
        operation="competitor_insight",
        topic=req.channel,
        language=req.language,
        creator_profile=creator_profile_block(req),
        source_summary=video_summary,
        user_instruction=f"Analyze competitor channel={req.channel}; max_videos={req.max_videos}.",
        format_contract=(
            "Return JSON object with channel, title_patterns, content_mix, upload_frequency, "
            "avg_views, top_performer, strengths, weaknesses, actionable_insights. "
            "If no recent videos are supplied, mark confidence as low and avoid invented metrics."
        ),
    ))

    analysis = await ask_claude_json(compiled.prompt, system=system_prompt, max_tokens=1800)

    duration_ms = int((time.monotonic() - start) * 1000)
    return CompetitorResponse(
        channel=req.channel,
        analysis=analysis if isinstance(analysis, dict) else {"raw": analysis},
        duration_ms=duration_ms,
        **build_operation_metadata(req, "competitor_insight", compiled),
    )
