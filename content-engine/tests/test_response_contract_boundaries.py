from datetime import datetime

import pytest
from pydantic import ValidationError

from models.requests import (
    CaptionResponse,
    DeepSearchRequest,
    DeepSearchResponse,
    FeedbackRequest,
    HooksRequest,
    HookVariant,
    HotNewsResponse,
    ReportRequest,
    ScriptRequest,
    ScriptResponse,
)
from models.research import ContentBrief, SearchResult, SourceReference, TrendingTopic
from models.scoring import ScoreBreakdown
from services.book_knowledge import BookDNA


def _source(**overrides) -> SourceReference:
    payload = {
        "source_id": "source_fixture",
        "title": "Bounded source",
        "url": "https://example.test/source",
        "source_type": "web",
    }
    payload.update(overrides)
    return SourceReference(**payload)


def _brief(**overrides) -> ContentBrief:
    payload = {
        "title": "Bounded brief",
        "hook": "A bounded opening line",
        "angle": "A bounded creator-neutral angle.",
        "format": "YouTube",
        "niche": "creator_ops",
        "sources": [_source()],
        "score": 0.8,
    }
    payload.update(overrides)
    return ContentBrief(**payload)


@pytest.mark.parametrize(
    "url",
    [
        " https://example.test/source",
        "https://example.test/unsafe path",
        "https://user:secret@example.test/source",
        "https://example.test:99999/source",
        "javascript:alert(1)",
    ],
)
def test_source_urls_reject_ambiguous_or_credentialed_values(url):
    with pytest.raises(ValidationError):
        _source(url=url)


@pytest.mark.parametrize(
    "metadata",
    [
        {"score": float("nan")},
        {"score": float("inf")},
        {"nested": {"private": "payload"}},
        {f"field_{index}": index for index in range(33)},
    ],
)
def test_search_result_rejects_unbounded_or_non_finite_metadata(metadata):
    with pytest.raises(ValidationError):
        SearchResult(
            title="Bounded result",
            url="https://example.test/result",
            source="web",
            metadata=metadata,
        )


def test_search_result_sanitizes_bounded_scalar_metadata_and_withholds_naive_dates():
    result = SearchResult(
        title="Bounded result",
        url="https://example.test/result",
        source="web",
        published_at=datetime(2026, 8, 31, 12, 0),
        metadata={"publisher": "Publisher\nName" + ("x" * 600)},
    )

    assert result.published_at is None
    assert "\n" not in result.metadata["publisher"]
    assert len(result.metadata["publisher"]) == 500


@pytest.mark.parametrize("score", [float("nan"), float("inf"), -0.1, 1.1, True, "0.5"])
def test_content_brief_rejects_invalid_scores(score):
    with pytest.raises(ValidationError):
        _brief(score=score)


def test_content_brief_rejects_extra_fields_and_unbounded_collections():
    with pytest.raises(ValidationError):
        _brief(private_provider_payload="must not cross")
    with pytest.raises(ValidationError):
        _brief(key_points=[f"point {index}" for index in range(25)])


def test_content_brief_revalidates_mutated_public_fields():
    brief = _brief()

    with pytest.raises(ValidationError):
        brief.why_now = "x" * 10_001


def test_trending_topic_rejects_non_finite_heat_and_unbounded_source_lists():
    with pytest.raises(ValidationError):
        TrendingTopic(topic="Bounded topic", heat_score=float("nan"))
    with pytest.raises(ValidationError):
        TrendingTopic(
            topic="Bounded topic",
            heat_score=0.5,
            sources=[f"source_{index}" for index in range(13)],
        )


def test_deep_search_response_rejects_unbounded_warnings_and_extra_fields():
    with pytest.raises(ValidationError):
        DeepSearchResponse(
            query="bounded query",
            briefs=[_brief()],
            search_count=1,
            duration_ms=1,
            warnings=["x" * 2_001],
        )
    with pytest.raises(ValidationError):
        DeepSearchResponse(
            query="bounded query",
            briefs=[_brief()],
            search_count=1,
            duration_ms=1,
            raw_provider_response="must not cross",
        )


@pytest.mark.parametrize("generated_at", ["not-a-date", "2026-08-31T12:00:00", 1_788_177_600])
def test_hot_news_response_requires_a_timezone_aware_timestamp(generated_at):
    with pytest.raises(ValidationError):
        HotNewsResponse(topics=[], generated_at=generated_at)


def test_provider_creative_payload_rejects_unexpected_fields():
    with pytest.raises(ValidationError):
        HookVariant(
            text="A bounded hook",
            trigger_type="curiosity_gap",
            score=8,
            why="Bounded reason.",
            sfx="none",
            edit_cue="text-popup",
            raw_provider_trace="must not cross",
        )


@pytest.mark.parametrize(
    "hashtags",
    [
        ["#prefixed"],
        ["contains space"],
        ["line\nbreak"],
        ["Duplicate", "duplicate"],
    ],
)
def test_caption_response_rejects_malformed_or_duplicate_hashtags(hashtags):
    with pytest.raises(ValidationError):
        CaptionResponse(
            topic="bounded topic",
            caption="",
            hashtags=hashtags,
            duration_ms=1,
            degraded=True,
        )


def test_script_response_rejects_unbounded_nested_objects():
    base = {
        "topic": "bounded topic",
        "script": "A complete bounded script body.",
        "hook": "A bounded hook",
        "title_options": ["A bounded title"],
        "sources_used": [_source()],
        "estimated_duration": "1:00",
        "duration_ms": 10,
        "hashtags": ["#bounded"],
        "caption": "A bounded caption.",
        "cta": "A bounded CTA.",
    }

    with pytest.raises(ValidationError):
        ScriptResponse(
            **base,
            estimated_cost={
                "estimatedInputTokens": 10,
                "estimatedOutputTokens": 10,
                "costConfidence": "high",
                "providerResponse": "must not cross",
            },
        )
    with pytest.raises(ValidationError):
        ScriptResponse(
            **base,
            research_route={
                "route": "evergreen_cached",
                "allowDeepSearch": False,
                "reason": "draft_or_evergreen_default",
                "groundingSubject": "bounded topic",
                "rawDecision": {"private": True},
            },
        )
    with pytest.raises(ValidationError):
        ScriptResponse(**{**base, "estimated_duration": "31:00"})


def test_book_response_contract_rejects_nested_provider_extras_and_overflow():
    with pytest.raises(ValidationError):
        BookDNA(
            title="Bounded book",
            author="Bounded author",
            core_thesis="Bounded thesis.",
            raw_provider_response="must not cross",
        )
    with pytest.raises(ValidationError):
        BookDNA(
            title="Bounded book",
            author="Bounded author",
            core_thesis="Bounded thesis.",
            related_thinkers=[f"Thinker {index}" for index in range(21)],
        )


@pytest.mark.parametrize("value", [float("nan"), float("inf"), True, "0.5"])
def test_score_breakdown_rejects_non_finite_or_coerced_values(value):
    with pytest.raises(ValidationError):
        ScoreBreakdown(composite=value)


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (DeepSearchRequest, {"query": "bounded query", "max_results": "10"}),
        (HooksRequest, {"topic": "bounded topic", "count": True}),
        (ScriptRequest, {"topic": "bounded topic", "max_duration_minutes": "8"}),
        (ScriptRequest, {"topic": "bounded topic", "target_duration_seconds": False}),
        (ScriptRequest, {"topic": "bounded topic", "force_refresh": "false"}),
        (FeedbackRequest, {"video_url": "https://example.test/video", "views": "10", "retention_pct": 50}),
        (FeedbackRequest, {"video_url": "https://example.test/video", "views": 10, "retention_pct": "50"}),
        (FeedbackRequest, {"video_url": "https://example.test/video", "views": 10, "retention_pct": True}),
        (FeedbackRequest, {"video_url": "https://example.test/video", "views": 10, "retention_pct": float("nan")}),
    ],
)
def test_public_requests_reject_coercive_or_non_finite_values(model, payload):
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (DeepSearchRequest, {"query": "bounded query", "unknown": "field"}),
        (ScriptRequest, {"topic": "bounded topic", "unknown": "field"}),
    ],
)
def test_public_requests_reject_unknown_top_level_fields(model, payload):
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_script_request_drops_agent_signals_with_unknown_nested_fields():
    request = ScriptRequest.model_validate({
        "topic": "bounded topic",
        "context_signals": [{"type": "trend", "source": "radar", "unknown": True}],
    })

    assert request.context_signals == []


@pytest.mark.parametrize(
    "payload",
    [
        {"query": "bounded query", "user_id": 0},
        {"query": "bounded query", "tenant_id": 9_007_199_254_740_992},
        {"query": "bounded query", "user_id": "42"},
    ],
)
def test_attribution_ids_require_positive_js_safe_integers(payload):
    with pytest.raises(ValidationError):
        DeepSearchRequest.model_validate(payload)


def test_report_scope_and_script_context_require_js_safe_integer_ids():
    with pytest.raises(ValidationError):
        ReportRequest.model_validate({
            "user_id": "42",
            "tenant_id": 42,
            "internal_attribution_token": "signed-token",
        })
    with pytest.raises(ValidationError):
        ScriptRequest.model_validate({
            "topic": "bounded topic",
            "topic_context": {"ideaId": 9_007_199_254_740_992},
        })


def test_script_regeneration_seed_rejects_control_characters():
    with pytest.raises(ValidationError):
        ScriptRequest.model_validate({
            "topic": "bounded topic",
            "regeneration_seed": "unsafe\nseed",
        })
