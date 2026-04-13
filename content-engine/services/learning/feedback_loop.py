"""
Feedback loop — analyses content performance metrics via Claude.

This module receives performance metrics and returns AI-generated analysis
of what worked, what didn't, and what to learn for future content.

STORAGE NOTE (April 2026):
  This module NO LONGER reads or writes feedback.json. The canonical
  feedback store is the SQLite `content_performance` table, managed by
  the TypeScript backend's content-learning-store.ts. The TS side
  persists feedback before calling this module for analysis.

  The old JSON path (data/feedback.json) has been fully removed.
  Historical data from the JSON file was migrated to SQLite by
  migration 031 and is accessible via GET /api/v1/content/performance.
"""

import time
import logging

from models.requests import FeedbackRequest, FeedbackResponse
from services.claude_client import ask_claude_json

logger = logging.getLogger("content-engine.feedback")


async def log_and_analyze(req: FeedbackRequest) -> FeedbackResponse:
    start = time.monotonic()

    # Build context from the request metrics. Historical averages are
    # now computed by the TS backend (getPerformanceSummary) — this
    # module only analyses the single entry it receives.
    context = f"""Video performance metrics:
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
2. strengths: what worked well (array of insights)
3. weaknesses: what could improve (array of insights)
4. learnings: specific patterns to remember for future content (array)
5. hook_analysis: if hook was provided, did it work? (string)
6. recommendations: 2-3 specific next steps (array)

Return JSON. Language: PT-BR for insights."""

    analysis = await ask_claude_json(prompt, category="content_engine_feedback")
    if not isinstance(analysis, dict):
        analysis = {"raw": analysis}

    duration_ms = int((time.monotonic() - start) * 1000)
    return FeedbackResponse(
        status="logged",
        analysis=analysis,
        duration_ms=duration_ms,
    )
