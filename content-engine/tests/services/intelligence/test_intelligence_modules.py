import ast
from pathlib import Path
from types import SimpleNamespace

import httpx
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
    assert response.operation_trace
    assert response.cost_tier == "medium"
    assert response.reuse_status == "fresh"
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
    # 2026-05-18 phase2-qa P2: previously the raw exception message
    # ("tenant-42 claude outage", or the AI proxy template
    # `f"AI proxy error {status} for category={category}"`) leaked to the
    # client via `str(e)`. Now redacted to a stable code so internal
    # infrastructure detail (status codes, category names, tenant markers)
    # never surfaces to iOS. The negative assertion below pins the fix.
    assert response.gaps[0]["error"] == "provider_unavailable"
    assert "tenant-42" not in response.gaps[0]["error"]


async def test_gap_finder_raw_malformed_output_returns_empty_list():
    async def fake_ask(*args, **kwargs):
        return {"raw": "not json"}

    gap_finder.ask_claude_json = fake_ask

    response = await gap_finder.find(GapsRequest(niche="fitness", max_gaps=2), RecordingOrchestrator())

    assert response.gaps == []


async def test_gap_finder_slices_model_gaps_to_requested_count(monkeypatch):
    async def fake_ask(*args, **kwargs):
        return [
            {"topic": "gap one", "gap_type": "quality_gap"},
            {"topic": "gap two", "gap_type": "quality_gap"},
            {"topic": "gap three", "gap_type": "quality_gap"},
        ]

    monkeypatch.setattr(gap_finder, "ask_claude_json", fake_ask)

    response = await gap_finder.find(GapsRequest(niche="fitness", max_gaps=2), RecordingOrchestrator())

    assert [gap["topic"] for gap in response.gaps] == ["gap one", "gap two"]


async def test_gap_finder_dict_model_output_is_wrapped(monkeypatch):
    async def fake_ask(*args, **kwargs):
        return {"topic": "single gap", "gap_type": "quality_gap"}

    monkeypatch.setattr(gap_finder, "ask_claude_json", fake_ask)

    response = await gap_finder.find(GapsRequest(niche="fitness", max_gaps=3), RecordingOrchestrator())

    assert response.gaps == [{"topic": "single gap", "gap_type": "quality_gap"}]


async def test_gap_finder_raw_dict_with_metadata_is_preserved(monkeypatch):
    async def fake_ask(*args, **kwargs):
        return {"raw": "manual JSON parse needed", "source": "tenant-42"}

    monkeypatch.setattr(gap_finder, "ask_claude_json", fake_ask)

    response = await gap_finder.find(GapsRequest(niche="fitness", max_gaps=3), RecordingOrchestrator())

    assert response.gaps == [{"raw": "manual JSON parse needed", "source": "tenant-42"}]


async def test_gap_finder_commentary_niche_uses_commentary_seed_topics(monkeypatch):
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        return [{"topic": "creator economy gap", "gap_type": "quality_gap"}]

    monkeypatch.setattr(gap_finder, "ask_claude_json", fake_ask)
    orchestrator = RecordingOrchestrator()

    await gap_finder.find(GapsRequest(niche="commentary", max_gaps=1), orchestrator)

    assert [topic for topic, _ in orchestrator.calls] == gap_finder.NICHE_SEED_TOPICS["commentary"]
    assert "creator economy trends" in captured["prompt"]
    assert "beginner hybrid training plan" not in captured["prompt"]


async def test_gap_finder_partial_research_failure_keeps_successful_context(monkeypatch):
    captured = {}

    class PartiallyFailingOrchestrator:
        def __init__(self):
            self.calls = []

        async def _fan_out(self, topic, max_per_searcher=3):
            self.calls.append(topic)
            if len(self.calls) == 1:
                raise RuntimeError("tenant-42 first searcher fault")
            return [SimpleNamespace(title=f"{topic} result")]

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        return [{"topic": "partial context gap", "gap_type": "quality_gap"}]

    monkeypatch.setattr(gap_finder, "ask_claude_json", fake_ask)
    orchestrator = PartiallyFailingOrchestrator()

    response = await gap_finder.find(GapsRequest(niche="fitness", max_gaps=1), orchestrator)

    assert response.gaps[0]["topic"] == "partial context gap"
    assert len(orchestrator.calls) == 5
    assert "strength training for runners" in captured["prompt"]
    assert "beginner hybrid training plan" not in captured["prompt"]


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
    assert response.operation_trace
    assert response.cost_tier == "medium"
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


async def test_competitor_fetch_without_youtube_key_never_opens_client(monkeypatch):
    class FailingClient:
        def __init__(self, *args, **kwargs):
            raise AssertionError("http client should not be opened without a key")

    monkeypatch.setattr(competitor_analyzer, "cfg", SimpleNamespace(youtube_api_key=""))
    monkeypatch.setattr(competitor_analyzer.httpx, "AsyncClient", FailingClient)

    videos = await competitor_analyzer._fetch_channel_videos("tenant-42 channel", 5)

    assert videos == []


async def test_competitor_fetch_empty_channel_search_returns_empty(monkeypatch):
    calls = []

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            calls.append((url, params))
            return FakeResponse({"items": []})

    monkeypatch.setattr(competitor_analyzer, "cfg", SimpleNamespace(youtube_api_key="tenant-key"))
    monkeypatch.setattr(competitor_analyzer.httpx, "AsyncClient", lambda *args, **kwargs: FakeClient())

    videos = await competitor_analyzer._fetch_channel_videos("tenant-42 channel", 8)

    assert videos == []
    assert len(calls) == 1
    assert calls[0][0] == competitor_analyzer.YT_SEARCH_URL


async def test_competitor_fetch_caps_recent_video_request_and_parses_stats(monkeypatch):
    calls = []

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            calls.append((url, params))
            if len(calls) == 1:
                return FakeResponse({
                    "items": [{
                        "id": {"channelId": "channel-42"},
                        "snippet": {"channelTitle": "Tenant 42"},
                    }]
                })
            if len(calls) == 2:
                return FakeResponse({
                    "items": [{
                        "id": {"videoId": "video-42"},
                        "snippet": {
                            "title": "Tenant scoped launch",
                            "publishedAt": "2026-05-06T12:00:00Z",
                        },
                    }]
                })
            return FakeResponse({
                "items": [{
                    "id": "video-42",
                    "statistics": {"viewCount": "1200", "likeCount": "80", "commentCount": "9"},
                }]
            })

    monkeypatch.setattr(competitor_analyzer, "cfg", SimpleNamespace(youtube_api_key="tenant-key"))
    monkeypatch.setattr(competitor_analyzer.httpx, "AsyncClient", lambda *args, **kwargs: FakeClient())

    videos = await competitor_analyzer._fetch_channel_videos("tenant-42 channel", 50)

    assert calls[1][1]["maxResults"] == 20
    assert videos == [{
        "title": "Tenant scoped launch",
        "published_at": "2026-05-06T12:00:00Z",
        "views": 1200,
        "likes": 80,
        "comments": 9,
        "channel": "Tenant 42",
    }]


async def test_competitor_fetch_skips_stats_when_recent_search_has_no_video_ids(monkeypatch):
    calls = []

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params):
            calls.append((url, params))
            if len(calls) == 1:
                return FakeResponse({
                    "items": [{
                        "id": {"channelId": "channel-42"},
                        "snippet": {"channelTitle": "Tenant 42"},
                    }]
                })
            return FakeResponse({"items": [{"id": {}, "snippet": {"title": "missing id"}}]})

    monkeypatch.setattr(competitor_analyzer, "cfg", SimpleNamespace(youtube_api_key="tenant-key"))
    monkeypatch.setattr(competitor_analyzer.httpx, "AsyncClient", lambda *args, **kwargs: FakeClient())

    videos = await competitor_analyzer._fetch_channel_videos("tenant-42 channel", 4)

    assert videos == []
    assert len(calls) == 2


async def test_competitor_analyze_uses_compact_claude_budget(monkeypatch):
    captured = {}

    async def fake_fetch(*args, **kwargs):
        return []

    async def fake_ask(prompt, **kwargs):
        captured["kwargs"] = kwargs
        return {"channel": "tenant-42 channel"}

    monkeypatch.setattr(competitor_analyzer, "_fetch_channel_videos", fake_fetch)
    monkeypatch.setattr(competitor_analyzer, "ask_claude_json", fake_ask)

    await competitor_analyzer.analyze(CompetitorRequest(channel="tenant-42 channel"))

    assert captured["kwargs"]["max_tokens"] == 1800


async def test_competitor_fetch_http_status_errors_are_not_swallowed(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            raise httpx.HTTPStatusError("tenant-42 forbidden", request=None, response=None)

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr(competitor_analyzer, "cfg", SimpleNamespace(youtube_api_key="tenant-key"))
    monkeypatch.setattr(competitor_analyzer.httpx, "AsyncClient", lambda *args, **kwargs: FakeClient())

    with pytest.raises(RuntimeError, match="YouTube competitor request failed at channel_search with status 0") as exc:
        await competitor_analyzer._fetch_channel_videos("tenant-42 channel", 5)
    assert "tenant-42 forbidden" not in str(exc.value)
    assert "tenant-key" not in str(exc.value)


def test_competitor_rejects_invalid_channel():
    with pytest.raises(ValidationError):
        CompetitorRequest(channel="")


def test_competitor_has_no_global_creator_profile_import():
    assert_no_imported_fallback_profile(competitor_analyzer)


@pytest.mark.parametrize("module", [gap_finder, competitor_analyzer])
def test_intelligence_system_prompts_have_no_founder_identity(module, assert_no_founder_identity):
    assert_no_founder_identity(getattr(module, "SYSTEM_PROMPT", ""))
