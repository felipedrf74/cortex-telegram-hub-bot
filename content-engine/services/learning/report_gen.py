"""
Report generator — weekly/monthly content performance digest via Claude.
"""

import time
import json
import os
import logging
from datetime import datetime, timezone, timedelta

from models.requests import ReportResponse
from services.claude_client import ask_claude_json

logger = logging.getLogger("content-engine.report")

FEEDBACK_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "data", "feedback.json")


def _load_history() -> list[dict]:
    try:
        if os.path.exists(FEEDBACK_FILE):
            with open(FEEDBACK_FILE, "r") as f:
                return json.load(f)
    except (json.JSONDecodeError, IOError):
        pass
    return []


async def generate(period: str = "week") -> ReportResponse:
    start = time.monotonic()

    history = _load_history()

    # Filter by period
    now = datetime.now(timezone.utc)
    if period == "month":
        cutoff = now - timedelta(days=30)
        period_label = "Last 30 Days"
    else:
        cutoff = now - timedelta(days=7)
        period_label = "Last 7 Days"

    recent = []
    for h in history:
        try:
            logged = datetime.fromisoformat(h.get("logged_at", ""))
            if logged.tzinfo is None:
                logged = logged.replace(tzinfo=timezone.utc)
            if logged >= cutoff:
                recent.append(h)
        except (ValueError, TypeError):
            continue

    if not recent:
        duration_ms = int((time.monotonic() - start) * 1000)
        return ReportResponse(
            period=period_label,
            report={
                "status": "no_data",
                "message": f"No feedback logged in the {period_label.lower()}. Use /feedback to start tracking.",
                "videos_published": 0,
            },
            duration_ms=duration_ms,
        )

    # Build context for Claude
    videos_summary = "\n".join(
        f"- Views: {v['views']:,} | Retention: {v['retention_pct']}% | Likes: {v['likes']:,} | "
        f"Comments: {v['comments']} | Subs: {v['subs_gained']} | Hook: {v.get('hook_used', 'N/A')}"
        for v in recent
    )

    prompt = f"""Generate a content performance report for the period: {period_label}

Data from {len(recent)} videos:
{videos_summary}

Create a report with:
1. videos_published: count
2. total_views: sum
3. avg_retention: average retention %
4. best_performer: which video did best and metrics
5. worst_performer: which did worst and why
6. top_insights: 3 key patterns observed (array)
7. recommendations: 3 specific suggestions for next period (array)
8. hook_analysis: which hooks worked best
9. trend_direction: "improving" | "stable" | "declining"

Return JSON. Insights in PT-BR."""

    report = await ask_claude_json(prompt)
    if not isinstance(report, dict):
        report = {"raw": report}

    duration_ms = int((time.monotonic() - start) * 1000)
    return ReportResponse(
        period=period_label,
        report=report,
        duration_ms=duration_ms,
    )
