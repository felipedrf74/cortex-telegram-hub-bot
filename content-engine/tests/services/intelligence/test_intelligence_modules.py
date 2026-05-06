import ast
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from models.requests import CompetitorRequest, GapsRequest
from services.intelligence import competitor_analyzer, gap_finder


class RecordingOrchestrator:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.calls = []

    async def _fan_out(self, topic, max_per_searcher=3):
        self.calls.append((topic, max_per_searcher))
        if self.fail:
            raise RuntimeError("tenant-42 search fault")
        return [
            SimpleNamespace(title=f"{topic} explained"),
            SimpleNamespace(title=f"{topic} checklist"),
        ]


def assert_no_imported_fallback_profile(module):
    source = Path(module.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    imported = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
    assert "_FALLBACK_PROFILE" not in imported
    assert "FALLBACK_PROFILE" not in imported


async def test_gap_finder_happy_path_threads_research_context(assert_no_founder_identity):
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["system"] = kwargs.get("system", "")
        return [
            {
                "topic": "tenant-42 recovery routine",
                "gap_type": "quality_gap",
                "search_demand": "medium",
                "existing_content_quality": "low",
                "opportunity_score": 8,
                "suggested_angle": "Use the current tenant request.",
                "suggested_title": "Recovery without chaos",
            }
        ]

    gap_finder.ask_claude_json = fake_ask
    orchestrator = RecordingOrchestrator()

    response = await gap_finder.find(GapsRequest(niche="fitness", max_gaps=3), orchestrator)

    assert response.gaps[0]["topic"] == "tenant-42 recovery routine"
    assert len(orchestrator.calls) == 5
    assert all(max_per_searcher == 3 for _, max_per_searcher in orchestrator.calls)
    assert "beginner hybrid training plan" in captured["prompt"]
    assert "tenant-99" not in captured["prompt"]
    assert_no_founder_identity(captured["prompt"], captured["system"], response.gaps)


async def test_gap_finder_unknown_niche_uses_safe_seed_fallback():
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        return [{"topic": "fallback opportunity", "gap_type": "quality_gap"}]

    gap_finder.ask_claude_json = fake_ask
    orchestrator = RecordingOrchestrator()

    response = await gap_finder.find(GapsRequest(niche="unknown", max_gaps=2), orchestrator)

    assert response.niche == "unknown"
    assert response.gaps
    assert orchestrator.calls[0][0] == "beginner hybrid training plan"
    assert "unknown" in captured["prompt"]


async def test_gap_finder_search_failures_still_return_model_gaps():
    async def fake_ask(*args, **kwargs):
        return [{"topic": "model-only gap", "gap_type": "quality_gap"}]

    gap_finder.ask_claude_json = fake_ask

    response = await gap_finder.find(GapsRequest(niche="fitness", max_gaps=1), RecordingOrchestrator(fail=True))

    assert response.gaps == [{"topic": "model-only gap", "gap_type": "quality_gap"}]


async def test_gap_finder_ai_failure_returns_degraded_error_shape():
    async def fake_ask(*args, **kwargs):
        raise RuntimeError("tenant-42 claude outage")

    gap_finder.ask_claude_json = fake_ask

    response = await gap_finder.find(GapsRequest(niche="fitness", max_gaps=2), RecordingOrchestrator())

    assert response.gaps[0]["gap_type"] == "error"
    assert "tenant-42 claude outage" in response.gaps[0]["error"]


async def test_gap_finder_raw_malformed_output_returns_empty_list():
    async def fake_ask(*args, **kwargs):
        return {"raw": "not json"}

    gap_finder.ask_claude_json = fake_ask

    response = await gap_finder.find(GapsRequest(niche="fitness", max_gaps=2), RecordingOrchestrator())

    assert response.gaps == []


def test_gap_finder_rejects_invalid_max_gaps():
    with pytest.raises(ValidationError):
        GapsRequest(max_gaps=0)


def test_gap_finder_has_no_global_creator_profile_import():
    assert_no_imported_fallback_profile(gap_finder)


async def test_competitor_no_youtube_key_uses_claude_only_prompt(monkeypatch, assert_no_founder_identity):
    captured = {}

    async def fake_fetch(channel_query, max_videos):
        assert channel_query == "tenant-42 channel"
        assert max_videos == 3
        return []

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        return {"channel": "tenant-42 channel", "strengths": ["clear packaging"]}

    monkeypatch.setattr(competitor_analyzer, "_fetch_channel_videos", fake_fetch)
    competitor_analyzer.ask_claude_json = fake_ask

    response = await competitor_analyzer.analyze(CompetitorRequest(channel="tenant-42 channel", max_videos=3))

    assert response.analysis["channel"] == "tenant-42 channel"
    assert "tenant-42 channel" in captured["prompt"]
    assert "Recent videos:" not in captured["prompt"]
    assert "tenant-99" not in captured["prompt"]
    assert_no_founder_identity(captured["prompt"], response.analysis)


async def test_competitor_with_videos_includes_recent_titles(monkeypatch):
    captured = {}

    async def fake_fetch(channel_query, max_videos):
        assert channel_query == "tenant-42 channel"
        assert max_videos == 2
        return [
            {
                "title": "tenant-42 calendar reset",
                "views": 1200,
                "likes": 90,
                "published_at": "2026-05-01T00:00:00Z",
            }
        ]

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        return {"top_performer": "tenant-42 calendar reset"}

    monkeypatch.setattr(competitor_analyzer, "_fetch_channel_videos", fake_fetch)
    competitor_analyzer.ask_claude_json = fake_ask

    response = await competitor_analyzer.analyze(CompetitorRequest(channel="tenant-42 channel", max_videos=2))

    assert response.analysis["top_performer"] == "tenant-42 calendar reset"
    assert "Recent videos:" in captured["prompt"]
    assert "tenant-42 calendar reset" in captured["prompt"]


async def test_competitor_non_dict_analysis_is_wrapped(monkeypatch):
    async def fake_fetch(*args, **kwargs):
        return []

    async def fake_ask(*args, **kwargs):
        return "plain text analysis"

    monkeypatch.setattr(competitor_analyzer, "_fetch_channel_videos", fake_fetch)
    competitor_analyzer.ask_claude_json = fake_ask

    response = await competitor_analyzer.analyze(CompetitorRequest(channel="tenant-42 channel"))

    assert response.analysis == {"raw": "plain text analysis"}


async def test_competitor_fetch_failure_is_visible(monkeypatch):
    async def fake_fetch(*args, **kwargs):
        raise RuntimeError("tenant-42 youtube fault")

    monkeypatch.setattr(competitor_analyzer, "_fetch_channel_videos", fake_fetch)

    with pytest.raises(RuntimeError, match="tenant-42 youtube fault"):
        await competitor_analyzer.analyze(CompetitorRequest(channel="tenant-42 channel"))


def test_competitor_rejects_invalid_channel():
    with pytest.raises(ValidationError):
        CompetitorRequest(channel="")


def test_competitor_has_no_global_creator_profile_import():
    assert_no_imported_fallback_profile(competitor_analyzer)


@pytest.mark.parametrize("module", [gap_finder, competitor_analyzer])
def test_intelligence_system_prompts_have_no_founder_identity(module, assert_no_founder_identity):
    assert_no_founder_identity(getattr(module, "SYSTEM_PROMPT", ""))
