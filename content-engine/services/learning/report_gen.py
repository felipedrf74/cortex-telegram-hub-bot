"""
Report generator — weekly/monthly content performance digest via Claude.

STORAGE NOTE (April 2026):
  This module NO LONGER reads from data/feedback.json. Performance data
  is fetched from the TypeScript backend's SQLite store via the internal
  API endpoint. The old JSON path has been fully removed.
"""

import os
import time
import logging

import httpx

from models.requests import ReportResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction

logger = logging.getLogger("content-engine.report")

_TS_BASE = (
    os.environ.get("NEXUS_BACKEND_BASE_URL")
    or os.environ.get("TS_BACKEND_BASE_URL")
    or f"http://localhost:{os.environ.get('NEXUS_BACKEND_PORT') or os.environ.get('TS_BACKEND_PORT') or '8200'}"
).rstrip("/")
_INTERNAL_SECRET = os.environ.get("INTERNAL_API_SECRET", "")
_PERFORMANCE_URL = f"{_TS_BASE}/api/v1/internal/performance-summary"


async def _fetch_performance_history(
    days: int,
    tenant_id: int | None = None,
    attribution_token: str | None = None,
) -> list[dict]:
    """Fetch performance history from the TS backend's canonical store."""
    if not _INTERNAL_SECRET:
        logger.warning("INTERNAL_API_SECRET not set — cannot fetch performance history")
        return []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            params: dict[str, int] = {"days": days}
            headers = {
                "x-internal-secret": _INTERNAL_SECRET,
            }
            if tenant_id is not None:
                params["tenantId"] = tenant_id
            if attribution_token:
                headers["x-internal-attribution-token"] = attribution_token
            resp = await client.get(_PERFORMANCE_URL, params=params, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                return data.get("entries", [])
    except Exception as e:
        logger.warning("Failed to fetch performance history: %s", e)
    return []


async def generate(
    period: str = "week",
    creator_profile: str | None = None,
    language: str = "en-US",
    tenant_id: int | None = None,
    attribution_token: str | None = None,
) -> ReportResponse:
    start = time.monotonic()

    # Fetch from canonical TS store
    days = 30 if period == "month" else 7
    period_label = "Last 30 Days" if period == "month" else "Last 7 Days"

    recent = await _fetch_performance_history(days, tenant_id=tenant_id, attribution_token=attribution_token)

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
        f"- Views: {v.get('views', 0):,} | Retention: {v.get('retentionPct', 0)}% | Likes: {v.get('likes', 0):,} | "
        f"Comments: {v.get('comments', 0)} | Subs: {v.get('subsGained', 0)} | Hook: {v.get('hookUsed', 'N/A')}"
        for v in recent
    )

    context = type("ReportCreatorContext", (), {
        "creator_profile": creator_profile,
        "language": language,
    })()
    system_prompt = f"""You are the authenticated creator's content performance report analyst.

{creator_profile_block(context)}

{language_instruction(context)}

Use only bounded performance summaries and creator profile details supplied for this request."""

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

Return JSON. Insights in {language}."""

    report = await ask_claude_json(prompt, system=system_prompt, category="content_engine_report")
    if not isinstance(report, dict):
        report = {"raw": report}

    duration_ms = int((time.monotonic() - start) * 1000)
    return ReportResponse(
        period=period_label,
        report=report,
        duration_ms=duration_ms,
    )
