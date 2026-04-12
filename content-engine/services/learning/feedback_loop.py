"""
Feedback loop — logs content performance and analyses it via Claude.

This is how the engine learns. Each /feedback call stores metrics and gets
back an analysis of what worked, what didn't, and what to learn.

DEPRECATION NOTICE (April 2026):
  The primary feedback store is now the SQLite-backed content_performance
  table, accessed via POST /api/v1/content/performance on the TypeScript
  backend. This Python module still writes to feedback.json for backward
  compatibility but the JSON file is no longer the source of truth.

  New callers should use the iOS/portal API endpoints instead:
    POST /api/v1/content/performance  — log feedback
    GET  /api/v1/content/performance  — read performance summary

  The JSON file will be removed in a future version.
"""

import time
import logging
import json
import os
from datetime import datetime, timezone

from models.requests import FeedbackRequest, FeedbackResponse
from services.claude_client import ask_claude_json

logger = logging.getLogger("content-engine.feedback")

# DEPRECATED: JSON file store. Primary store is now SQLite content_performance table.
# Kept for backward compatibility — reads still check this file as a fallback.
FEEDBACK_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "data", "feedback.json")


def _load_history() -> list[dict]:
    """Load feedback history from JSON file."""
    try:
        if os.path.exists(FEEDBACK_FILE):
            with open(FEEDBACK_FILE, "r") as f:
                return json.load(f)
    except (json.JSONDecodeError, IOError):
        pass
    return []


def _save_history(history: list[dict]) -> None:
    """Save feedback history to JSON file."""
    os.makedirs(os.path.dirname(FEEDBACK_FILE), exist_ok=True)
    with open(FEEDBACK_FILE, "w") as f:
        json.dump(history, f, indent=2, default=str)


async def log_and_analyze(req: FeedbackRequest) -> FeedbackResponse:
    start = time.monotonic()

    # Load history and append new entry
    history = _load_history()
    entry = {
        "video_url": req.video_url,
        "views": req.views,
        "retention_pct": req.retention_pct,
        "likes": req.likes,
        "comments": req.comments,
        "subs_gained": req.subs_gained,
        "hook_used": req.hook_used,
        "notes": req.notes,
        "logged_at": datetime.now(timezone.utc).isoformat(),
    }
    history.append(entry)
    _save_history(history)

    # Compute averages from history
    if len(history) > 1:
        avg_views = sum(h["views"] for h in history) / len(history)
        avg_retention = sum(h["retention_pct"] for h in history) / len(history)
        avg_likes = sum(h["likes"] for h in history) / len(history)
        context = f"""Historical averages (from {len(history)} videos):
- Avg views: {avg_views:.0f}
- Avg retention: {avg_retention:.1f}%
- Avg likes: {avg_likes:.0f}

This video's metrics:
- Views: {req.views} ({'+' if req.views > avg_views else ''}{((req.views/avg_views - 1)*100):.0f}% vs avg)
- Retention: {req.retention_pct}% ({'+' if req.retention_pct > avg_retention else ''}{req.retention_pct - avg_retention:.1f}% vs avg)
- Likes: {req.likes}
- Comments: {req.comments}
- Subs gained: {req.subs_gained}"""
    else:
        context = f"""First feedback entry — no historical comparison yet.
- Views: {req.views}
- Retention: {req.retention_pct}%
- Likes: {req.likes}
- Comments: {req.comments}
- Subs gained: {req.subs_gained}"""

    if req.hook_used:
        context += f"\n- Hook used: {req.hook_used}"
    if req.notes:
        context += f"\n- Creator notes: {req.notes}"

    prompt = f"""Analyze this content performance feedback:

{context}
Video URL: {req.video_url}

Provide analysis with:
1. performance_level: "exceptional" | "above_average" | "average" | "below_average" | "poor"
2. vs_average: percentage comparison to historical averages (or "first_entry" if no history)
3. strengths: what worked well (array of insights)
4. weaknesses: what could improve (array of insights)
5. learnings: specific patterns to remember for future content (array)
6. hook_analysis: if hook was provided, did it work? (string)
7. recommendations: 2-3 specific next steps (array)

Return JSON. Language: PT-BR for insights."""

    analysis = await ask_claude_json(prompt)
    if not isinstance(analysis, dict):
        analysis = {"raw": analysis}

    duration_ms = int((time.monotonic() - start) * 1000)
    return FeedbackResponse(
        status="logged",
        analysis=analysis,
        duration_ms=duration_ms,
    )
