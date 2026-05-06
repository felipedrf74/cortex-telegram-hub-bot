import ast
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from models.requests import FeedbackRequest, SeoRequest
from models.research import SearchResult
from models.scoring import ScoreBreakdown, ScoredResult
from services import book_knowledge, brief_builder, claude_client, scorer, source_registry
from services.intelligence import seo_engine
from services.learning import feedback_loop, report_gen


TARGET_MODULES = [
    book_knowledge,
    brief_builder,
    claude_client,
    feedback_loop,
    report_gen,
    scorer,
    seo_engine,
    source_registry,
]


def imported_names(module) -> list[str]:
    source = Path(module.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
    return names


@pytest.mark.parametrize("module", TARGET_MODULES, ids=lambda module: module.__name__.split(".")[-1])
def test_no_global_creator_profile_import(module):
    imports = imported_names(module)
    assert "_FALLBACK_PROFILE" not in imports
    assert "FALLBACK_PROFILE" not in imports


def search_result(title="tenant-42 AI workflow", snippet="AI automation checklist", **metadata):
    return SearchResult(
        title=title,
        url="https://example.test/story",
        snippet=snippet,
        source=metadata.pop("source", "web"),
        published_at=metadata.pop("published_at", None),
        metadata=metadata,
    )


def test_scorer_uses_request_creator_keywords_for_relevance():
    result = search_result(title="tenant-42 calendar planning", snippet="private workspace")

    scored = scorer.score_result(result, creator_keywords=["calendar", "workspace"])

    assert scored.score.relevance > 0
    assert scored.score.composite > 0


def test_scorer_empty_creator_keywords_degrades_to_zero_relevance():
    result = search_result(title="tenant-42 calendar planning", snippet="private workspace")

    scored = scorer.score_result(result, creator_keywords=[])

    assert scored.score.relevance == 0


def test_scorer_ranks_by_composite_score():
    recent = search_result(
        title="AI automation launch",
        snippet="machine learning and gpt automation",
        published_at=datetime.now(timezone.utc) - timedelta(hours=1),
        view_count=900000,
    )
    stale = search_result(
        title="generic archive",
        snippet="old reference",
        published_at=datetime.now(timezone.utc) - timedelta(days=10),
        view_count=10,
    )

    ranked = scorer.score_results([stale, recent], creator_keywords=["ai", "automation"])

    assert ranked[0].result.title == "AI automation launch"
    assert ranked[0].score.composite >= ranked[1].score.composite


def test_scorer_default_keywords_are_founder_neutral(assert_no_founder_identity):
    assert_no_founder_identity(scorer.NICHE_KEYWORDS)


def test_scorer_unknown_date_gets_neutral_recency():
    scored = scorer.score_result(search_result(), creator_keywords=["ai"])

    assert scored.score.recency == 0.3


def test_brief_builder_builds_actionable_brief_without_mock_noise():
    scored = ScoredResult(
        result=search_result(
            title="[Mock] tenant-42 Launch Plan",
            snippet="Mock data. Set API_KEY to get real results. Real signal remains.",
            source="youtube",
        ),
        score=ScoreBreakdown(relevance=0.8, virality=0.5, recency=0.9, composite=0.75),
    )

    briefs = brief_builder.build_briefs([scored], max_briefs=1)

    assert len(briefs) == 1
    assert briefs[0].title == "tenant-42 Launch Plan"
    assert briefs[0].format == "YouTube"
    assert briefs[0].time_sensitive is True
    assert "Set API_KEY" not in briefs[0].why_now


def test_brief_builder_respects_max_briefs():
    items = [
        ScoredResult(result=search_result(title=f"item {idx}"), score=ScoreBreakdown(composite=0.5))
        for idx in range(4)
    ]

    briefs = brief_builder.build_briefs(items, max_briefs=2)

    assert [brief.title for brief in briefs] == ["item 0", "item 1"]


def test_brief_builder_niche_detection_uses_genre_keywords():
    scored = ScoredResult(
        result=search_result(title="triathlon recovery workout", snippet="running and cycling"),
        score=ScoreBreakdown(composite=0.6),
    )

    brief = brief_builder.build_briefs([scored])[0]

    assert brief.niche == "training"


def test_claude_client_extracts_fenced_json_candidate():
    raw = "```json\n{\"ok\": true, \"tenant\": 42}\n```"

    assert claude_client._extract_json_candidate(raw) == '{"ok": true, "tenant": 42}'


def test_claude_client_extracts_nested_json_from_text():
    raw = "prefix {\"items\": [{\"id\": 1}]} suffix"

    assert claude_client._extract_json_candidate(raw) == '{"items": [{"id": 1}]}'


async def test_claude_client_ask_json_parses_proxy_text(monkeypatch):
    async def fake_ask(*args, **kwargs):
        return "```json\n{\"answer\":\"tenant-42\"}\n```"

    monkeypatch.setattr(claude_client, "ask_claude", fake_ask)

    assert await claude_client.ask_claude_json("prompt") == {"answer": "tenant-42"}


async def test_claude_client_json_repair_path(monkeypatch):
    async def fake_ask(*args, **kwargs):
        return "{not json"

    async def fake_repair(*args, **kwargs):
        return {"repaired": True}

    monkeypatch.setattr(claude_client, "ask_claude", fake_ask)
    monkeypatch.setattr(claude_client, "_repair_json_response", fake_repair)

    assert await claude_client.ask_claude_json("prompt") == {"repaired": True}


async def test_claude_client_raw_fallback_when_repair_fails(monkeypatch):
    async def fake_ask(*args, **kwargs):
        return "not-json"

    async def fake_repair(*args, **kwargs):
        return None

    monkeypatch.setattr(claude_client, "ask_claude", fake_ask)
    monkeypatch.setattr(claude_client, "_repair_json_response", fake_repair)

    assert await claude_client.ask_claude_json("prompt") == {"raw": "not-json"}


async def test_book_knowledge_no_search_results_returns_low_confidence(monkeypatch):
    async def fake_search(*args, **kwargs):
        return []

    async def fail_ask(*args, **kwargs):
        raise AssertionError("AI should not be called without research context")

    monkeypatch.setattr(book_knowledge, "_web_search", fake_search)
    monkeypatch.setattr(book_knowledge, "ask_claude_json", fail_ask)

    dna = await book_knowledge.extract_book("Tenant Manual", "A. Author")

    assert dna.title == "Tenant Manual"
    assert "LOW CONFIDENCE" in dna.core_thesis
    assert dna.key_frameworks == []


async def test_book_knowledge_synthesizes_search_results(monkeypatch, assert_no_founder_identity):
    captured = {}

    async def fake_search(query, max_results=5):
        return [{"title": "Tenant research", "snippet": query, "link": "https://example.test"}]

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["system"] = kwargs.get("system", "")
        return {
            "title": "Tenant Manual",
            "author": "A. Author",
            "core_thesis": "Use scoped research.",
            "key_frameworks": [{"name": "Scope", "description": "Per request"}],
            "quotable_ideas": [{"idea": "Stay scoped"}],
            "pillar_mapping": ["ops"],
            "counter_arguments": ["Needs validation"],
            "related_thinkers": ["none"],
            "personal_notes": [],
        }

    monkeypatch.setattr(book_knowledge, "_web_search", fake_search)
    monkeypatch.setattr(book_knowledge, "ask_claude_json", fake_ask)
    monkeypatch.setattr(book_knowledge, "get_profile", lambda: "Neutral authenticated creator profile")

    dna = await book_knowledge.extract_book("Tenant Manual", "A. Author")

    assert dna.core_thesis == "Use scoped research."
    assert "Tenant research" in captured["prompt"]
    assert "authenticated creator" in captured["system"].lower()
    assert_no_founder_identity(captured["prompt"], captured["system"], dna.model_dump())


class RecordingOrchestrator:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    async def _fan_out(self, topic, max_per_searcher=5):
        self.calls.append((topic, max_per_searcher))
        if self.fail:
            raise RuntimeError("tenant-42 fanout fault")
        return [
            SimpleNamespace(title="tenant-42 launch playbook"),
            SimpleNamespace(title="tenant-42 weekly plan"),
        ]


async def test_seo_engine_happy_path_threads_existing_titles(monkeypatch, assert_no_founder_identity):
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["system"] = kwargs.get("system", "")
        return [{"keyword": "tenant-42 launch", "opportunity_score": 8}]

    monkeypatch.setattr(seo_engine, "ask_claude_json", fake_ask)

    response = await seo_engine.analyze(SeoRequest(topic="tenant-42 launch", platform="YouTube"), RecordingOrchestrator())

    assert response.clusters[0]["keyword"] == "tenant-42 launch"
    assert "tenant-42 launch playbook" in captured["prompt"]
    assert_no_founder_identity(captured["prompt"], captured["system"])


async def test_seo_engine_fanout_failure_still_returns_model_clusters(monkeypatch):
    async def fake_ask(*args, **kwargs):
        return [{"keyword": "fallback keyword"}]

    monkeypatch.setattr(seo_engine, "ask_claude_json", fake_ask)

    response = await seo_engine.analyze(SeoRequest(topic="tenant-42 launch"), RecordingOrchestrator(fail=True))

    assert response.clusters == [{"keyword": "fallback keyword"}]


async def test_feedback_loop_builds_metric_context(monkeypatch, assert_no_founder_identity):
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["category"] = kwargs.get("category")
        return {"performance_level": "above_average", "strengths": ["clear hook"]}

    monkeypatch.setattr(feedback_loop, "ask_claude_json", fake_ask)

    response = await feedback_loop.log_and_analyze(
        FeedbackRequest(
            video_url="https://example.test/video",
            views=1000,
            retention_pct=62.5,
            likes=100,
            comments=8,
            subs_gained=4,
            hook_used="tenant-42 hook",
            notes="tenant-42 note",
        )
    )

    assert response.status == "logged"
    assert response.analysis["performance_level"] == "above_average"
    assert "tenant-42 hook" in captured["prompt"]
    assert captured["category"] == "content_engine_feedback"
    assert_no_founder_identity(captured["prompt"], response.analysis)


async def test_feedback_loop_non_dict_analysis_is_wrapped(monkeypatch):
    async def fake_ask(*args, **kwargs):
        return ["unexpected"]

    monkeypatch.setattr(feedback_loop, "ask_claude_json", fake_ask)

    response = await feedback_loop.log_and_analyze(
        FeedbackRequest(video_url="https://example.test/video", views=1, retention_pct=1)
    )

    assert response.analysis == {"raw": ["unexpected"]}


async def test_report_generator_no_data_returns_degraded_message(monkeypatch):
    async def fake_history(days):
        return []

    monkeypatch.setattr(report_gen, "_fetch_performance_history", fake_history)

    response = await report_gen.generate("week")

    assert response.period == "Last 7 Days"
    assert response.report["status"] == "no_data"
    assert response.report["videos_published"] == 0


async def test_report_generator_with_history_summarizes_metrics(monkeypatch, assert_no_founder_identity):
    captured = {}

    async def fake_history(days):
        assert days == 30
        return [
            {
                "views": 1234,
                "retentionPct": 58,
                "likes": 120,
                "comments": 9,
                "subsGained": 5,
                "hookUsed": "tenant-42 hook",
            }
        ]

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        return {"videos_published": 1, "top_insights": ["tenant-42 hook worked"]}

    monkeypatch.setattr(report_gen, "_fetch_performance_history", fake_history)
    monkeypatch.setattr(report_gen, "ask_claude_json", fake_ask)

    response = await report_gen.generate("month")

    assert response.period == "Last 30 Days"
    assert response.report["videos_published"] == 1
    assert "tenant-42 hook" in captured["prompt"]
    assert_no_founder_identity(captured["prompt"], response.report)


def test_source_registry_generates_political_verification_queries():
    queries = source_registry.get_verification_queries("Bolsonaro election status")

    assert any("tse.jus.br" in query for query in queries)
    assert any("situação atual" in query for query in queries)


def test_source_registry_generates_health_queries():
    queries = source_registry.get_verification_queries("creatina corrida estudo")

    assert any("pubmed" in query for query in queries)
    assert any("examine.com" in query for query in queries)


def test_source_registry_unknown_topic_has_no_forced_queries():
    assert source_registry.get_verification_queries("tenant-42 editorial calendar") == []
