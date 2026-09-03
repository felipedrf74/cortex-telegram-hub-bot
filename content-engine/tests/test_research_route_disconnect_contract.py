import asyncio
import importlib
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize(
    ("route_name", "request_type", "payload", "needs_orchestrator"),
    [
        ("deep_search", "DeepSearchRequest", {"query": "safe topic"}, True),
        ("hot_news_with_context", "HotNewsRequest", {}, True),
        ("generate_hooks", "HooksRequest", {"topic": "safe topic"}, False),
        ("generate_script", "ScriptRequest", {"topic": "safe topic"}, True),
        ("generate_titles", "TitlesRequest", {"topic": "safe topic"}, False),
        ("generate_thumbnail", "ThumbnailRequest", {"title": "safe title"}, False),
        ("generate_caption", "CaptionRequest", {"topic": "safe topic"}, False),
        ("analyze_competitor", "CompetitorRequest", {"channel": "safe-channel"}, False),
        ("find_gaps", "GapsRequest", {"niche": "general"}, True),
        ("seo_analysis", "SeoRequest", {"topic": "safe topic"}, True),
        (
            "repurpose",
            "RepurposeRequest",
            {"topic": "safe topic", "source_content": "Safe source content."},
            False,
        ),
        (
            "log_feedback",
            "FeedbackRequest",
            {"video_url": "https://example.com/video", "views": 1, "retention_pct": 50},
            False,
        ),
        (
            "weekly_report_with_context",
            "ReportRequest",
            {"user_id": 7, "tenant_id": 7, "internal_attribution_token": "signed-token"},
            False,
        ),
    ],
)
def test_cost_bearing_routes_bind_request_disconnect_to_attributed_operation(
    monkeypatch,
    route_name,
    request_type,
    payload,
    needs_orchestrator,
):
    research = importlib.import_module("routers.research")
    request_models = importlib.import_module("models.requests")
    client_request = SimpleNamespace(is_disconnected=None)
    captured = {}
    sentinel = object()

    async def capture_attribution(req, operation, client_request=None):
        captured["request"] = client_request
        captured["operation"] = operation
        return sentinel

    monkeypatch.setattr(research, "_with_ai_attribution", capture_attribution)
    monkeypatch.setattr(research, "_creative_topic_guard", lambda *_args: None)
    request_body = getattr(request_models, request_type)(**payload)
    route = getattr(research, route_name)

    if needs_orchestrator:
        result = asyncio.run(route(request_body, client_request, orch=SimpleNamespace()))
    else:
        result = asyncio.run(route(request_body, client_request))

    assert result is sentinel
    assert captured["request"] is client_request
    assert callable(captured["operation"])


@pytest.mark.parametrize(
    ("route_name", "route_args"),
    [
        ("get_sources", {"query": "safe topic", "language": "en-US"}),
        ("trending", {"niche": None, "language": "en-US"}),
        ("reaction_search", {"topic": "safe topic", "language": "en-US"}),
    ],
)
def test_cost_bearing_get_routes_bind_search_work_to_request_disconnect(
    monkeypatch,
    route_name,
    route_args,
):
    research = importlib.import_module("routers.research")
    client_request = SimpleNamespace(is_disconnected=None)
    captured = {}
    sentinel = object()

    async def capture_disconnect(request, operation):
        captured["request"] = request
        captured["operation"] = operation
        return sentinel

    monkeypatch.setattr(research, "_run_until_client_disconnect", capture_disconnect)
    route = getattr(research, route_name)

    result = asyncio.run(route(
        request=client_request,
        orch=SimpleNamespace(),
        **route_args,
    ))

    assert result is sentinel
    assert captured["request"] is client_request
    assert callable(captured["operation"])


def test_book_extraction_binds_provider_fanout_to_request_disconnect(monkeypatch):
    books = importlib.import_module("routers.books")
    client_request = SimpleNamespace(is_disconnected=None)
    captured = {}

    async def capture_disconnect(request, operation):
        captured["request"] = request
        captured["operation"] = operation
        return books.BookDNA(
            title="Safe Book",
            author="Safe Author",
            core_thesis="Scoped thesis.",
            key_frameworks=[],
            quotable_ideas=[],
            pillar_mapping=[],
            counter_arguments=[],
            related_thinkers=[],
            personal_notes=[],
        ), {}

    monkeypatch.setattr(books, "run_until_client_disconnect", capture_disconnect)
    monkeypatch.setattr(books, "classify_operation_topic", lambda _topic: {"route": "general"})

    result = asyncio.run(books.extract_book_endpoint(
        books.BookExtractRequest(title="Safe Book", author="Safe Author"),
        client_request,
    ))

    assert result.book.title == "Safe Book"
    assert captured["request"] is client_request
    assert callable(captured["operation"])


def test_book_extraction_propagates_and_resets_full_inference_attribution_on_cancellation(monkeypatch):
    books = importlib.import_module("routers.books")
    client_request = SimpleNamespace(is_disconnected=None)
    captured = {}
    attribution_token = object()

    def capture_set_attribution(**kwargs):
        captured["attribution"] = kwargs
        return attribution_token

    def capture_reset(token):
        captured["reset"] = token

    async def cancel_disconnect(_request, _operation):
        raise asyncio.CancelledError()

    monkeypatch.setattr(books, "set_attribution_context", capture_set_attribution)
    monkeypatch.setattr(books, "reset_attribution_context", capture_reset)
    monkeypatch.setattr(books, "run_until_client_disconnect", cancel_disconnect)
    monkeypatch.setattr(books, "classify_operation_topic", lambda _topic: {"route": "general"})

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(books.extract_book_endpoint(
            books.BookExtractRequest(
                title="Safe Book",
                author="Safe Author",
                user_id=7,
                tenant_id=44,
                internal_attribution_token="signed-token",
                internal_inference_attribution_token="signed-inference-token",
                internal_inference_proof_key="signed-proof-key",
            ),
            client_request,
        ))

    assert captured["attribution"] == {
        "user_id": 7,
        "tenant_id": 44,
        "attribution_token": "signed-token",
        "inference_attribution_token": "signed-inference-token",
        "inference_proof_key": "signed-proof-key",
    }
    assert captured["reset"] is attribution_token
