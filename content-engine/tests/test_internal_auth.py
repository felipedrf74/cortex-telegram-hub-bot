import asyncio
import importlib
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient


def test_attributed_content_operation_is_cancelled_when_the_client_disconnects(monkeypatch):
    _reload_content_engine(monkeypatch, secret="valid-secret")
    research = importlib.import_module("routers.research")

    async def scenario():
        disconnected = asyncio.Event()
        operation_started = asyncio.Event()
        operation_cancelled = asyncio.Event()

        class DisconnectingRequest:
            async def is_disconnected(self):
                await disconnected.wait()
                return True

        async def operation():
            operation_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                operation_cancelled.set()
                raise

        task = asyncio.create_task(research._with_ai_attribution(
            SimpleNamespace(
                user_id=7,
                tenant_id=44,
                internal_attribution_token=None,
                internal_inference_attribution_token="signed-local-token",
                internal_inference_proof_key="signed-proof-key",
            ),
            operation,
            client_request=DisconnectingRequest(),
        ))
        await operation_started.wait()
        disconnected.set()
        try:
            await task
            raise AssertionError("expected disconnect cancellation")
        except asyncio.CancelledError:
            pass
        assert operation_cancelled.is_set()

    asyncio.run(scenario())


def _reload_content_engine(monkeypatch, *, secret: str = "test-content-engine-secret", env: str = "test"):
    monkeypatch.setenv("INTERNAL_API_SECRET", secret)
    monkeypatch.setenv("ENV", env)
    for module_name in ("main", "config"):
        sys.modules.pop(module_name, None)
    return importlib.import_module("main")


def test_health_is_public_and_echoes_request_id(monkeypatch):
    main = _reload_content_engine(monkeypatch)
    client = TestClient(main.app)

    response = client.get("/health", headers={"x-request-id": "req-health"})

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.headers["x-request-id"] == "req-health"


@pytest.mark.parametrize("headers", [{}, {"x-internal-secret": "wrong-secret"}])
def test_protected_routes_reject_missing_or_wrong_secret(monkeypatch, headers):
    main = _reload_content_engine(monkeypatch)
    client = TestClient(main.app)

    response = client.get("/api/v1/not-a-real-route", headers={**headers, "x-request-id": "req-denied"})

    assert response.status_code == 401
    assert response.json() == {"error": {"code": "UNAUTHORIZED", "message": "Unauthorized"}}
    assert response.headers["x-request-id"] == "req-denied"


def test_protected_routes_accept_valid_secret_before_routing(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    client = TestClient(main.app)

    response = client.get(
        "/api/v1/not-a-real-route",
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-allowed"},
    )

    assert response.status_code == 404
    assert response.headers["x-request-id"] == "req-allowed"


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/sources?query=ceramics&language=fr-FR",
        "/api/v1/trending?language=fr-FR",
        "/api/v1/reaction?topic=ceramics&language=fr-FR",
    ],
)
def test_research_query_routes_reject_unsupported_languages_before_operation(monkeypatch, path):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    client = TestClient(main.app)

    response = client.get(
        path,
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-language"},
    )

    assert response.status_code == 422
    assert response.headers["x-request-id"] == "req-language"


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/sources?query=%20%20%20",
        "/api/v1/sources?query=safe%00hidden",
        "/api/v1/trending?niche=%20%20%20",
        "/api/v1/trending?niche=safe%0Ahidden",
        "/api/v1/reaction?topic=%20%20%20",
        "/api/v1/reaction?topic=safe%7Fhidden",
    ],
)
def test_research_query_routes_reject_blank_or_control_bearing_inputs(monkeypatch, path):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    client = TestClient(main.app)

    response = client.get(
        path,
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-query-boundary"},
    )

    assert response.status_code == 422
    assert response.headers["x-request-id"] == "req-query-boundary"


def test_protected_routes_reject_non_ascii_secret_without_500(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    client = TestClient(main.app)

    response = client.get(
        "/api/v1/not-a-real-route",
        headers={"x-internal-secret": b"\xe9", "x-request-id": "req-nonascii"},
    )

    assert response.status_code == 401
    assert response.json() == {"error": {"code": "UNAUTHORIZED", "message": "Unauthorized"}}
    assert response.headers["x-request-id"] == "req-nonascii"


def test_ready_requires_secret_and_reports_readiness(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    client = TestClient(main.app)

    denied = client.get("/ready", headers={"x-request-id": "req-ready-denied"})
    assert denied.status_code == 401

    response = client.get(
        "/ready",
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-ready"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert response.json()["internalAuthConfigured"] is True
    assert response.headers["x-request-id"] == "req-ready"


@pytest.mark.parametrize(
    ("path", "payload", "expected_code"),
    [
        ("/api/v1/hooks", {"topic": "how to hack a competitor account"}, "CONTENT_UNSUPPORTED_TOPIC"),
        ("/api/v1/hooks", {"topic": "latest child pornography content today"}, "CONTENT_UNSUPPORTED_TOPIC"),
        ("/api/v1/hooks", {"topic": "make a deep fake of a real person"}, "CONTENT_UNSUPPORTED_TOPIC"),
        ("/api/v1/hooks", {"topic": "safe topic", "niche": "how to hack a competitor account"}, "CONTENT_UNSUPPORTED_TOPIC"),
        ("/api/v1/script", {"topic": "how to hack a competitor account"}, "CONTENT_UNSUPPORTED_TOPIC"),
        ("/api/v1/script", {"topic": "ibuprofen dosage", "mode": "standard"}, "CONTENT_HIGH_RISK_REVIEW_REQUIRED"),
        ("/api/v1/caption", {"topic": "should I take ibuprofen for migraines"}, "CONTENT_HIGH_RISK_REVIEW_REQUIRED"),
        ("/api/v1/hooks", {"topic": "latest creator trend today"}, "CONTENT_RESEARCH_REQUIRED"),
        ("/api/v1/thumbnail", {"title": "how to hack a competitor account", "topic": "   "}, "CONTENT_UNSUPPORTED_TOPIC"),
        ("/api/v1/repurpose", {"topic": "safe topic", "source_content": "how to hack a competitor account"}, "CONTENT_UNSUPPORTED_TOPIC"),
        (
            "/api/v1/repurpose",
            {
                "topic": "safe topic",
                "niche": "how to hack a competitor account",
                "source_content": "safe source",
            },
            "CONTENT_UNSUPPORTED_TOPIC",
        ),
    ],
)
def test_creative_pack_routes_block_unsafe_topics_before_ai(monkeypatch, path, payload, expected_code):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    client = TestClient(main.app)

    response = client.post(
        path,
        json=payload,
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-content-safety"},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"]["code"] == expected_code
    assert response.json()["detail"]["error"]["details"]["researchRoute"]["route"] in {
        "unsupported",
        "high_risk_review",
        "fresh_compact",
    }


@pytest.mark.parametrize("mode", ["draft", "quick", "standard", "deep"])
def test_script_high_risk_topic_is_blocked_in_every_generation_mode(mode):
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")

    with pytest.raises(research.HTTPException) as blocked:
        research._script_topic_guard(requests.ScriptRequest(topic="ibuprofen dosage", mode=mode))
    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == "CONTENT_HIGH_RISK_REVIEW_REQUIRED"


def test_script_high_risk_niche_is_blocked_before_generation():
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")

    with pytest.raises(research.HTTPException) as blocked:
        research._script_topic_guard(requests.ScriptRequest(
            topic="calm evergreen launch plan",
            niche="antidepressant tapering schedule",
        ))

    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == "CONTENT_HIGH_RISK_REVIEW_REQUIRED"


def test_script_high_risk_guard_precedes_oversized_canonical_research_subject():
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")
    request = requests.ScriptRequest(
        topic="t" * 1_850,
        niche="ibuprofen dosage " + ("n" * 140),
    )

    with pytest.raises(research.HTTPException) as blocked:
        research._script_topic_guard(request)

    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == "CONTENT_HIGH_RISK_REVIEW_REQUIRED"


@pytest.mark.parametrize(
    "request_factory",
    [
        lambda requests: requests.ScriptRequest(
            topic="calm ceramics workflow",
            niche="ceramics",
            research_query="ceramics only",
        ),
        lambda requests: requests.ScriptRequest(
            topic="t" * 1_850,
            niche="n" * 160,
        ),
    ],
)
def test_script_route_maps_safe_invalid_research_subject_to_stable_422(request_factory):
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")
    script_request = request_factory(requests)

    research._script_topic_guard(script_request)
    with pytest.raises(research.HTTPException) as blocked:
        research._validate_script_research_query(script_request)

    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == "CONTENT_RESEARCH_QUERY_INVALID"


@pytest.mark.parametrize(
    ("topic_context", "expected_code"),
    [
        ({"hookIdea": "ibuprofen dosage guidance"}, "CONTENT_HIGH_RISK_REVIEW_REQUIRED"),
        ({"whyNow": "steal account credentials"}, "CONTENT_UNSUPPORTED_TOPIC"),
    ],
)
def test_script_nested_topic_context_is_classified_before_generation(topic_context, expected_code):
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")

    with pytest.raises(research.HTTPException) as blocked:
        research._script_topic_guard(requests.ScriptRequest(
            topic="calm evergreen launch plan",
            topic_context=topic_context,
        ))

    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == expected_code


def test_internal_creative_guard_rejects_high_risk_even_with_scoped_source_context():
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")
    grounded = requests.HooksRequest(
        topic="latest ibuprofen research today",
        source_package_id="sp_scoped_package",
        source_summary=["Reviewed evidence summary from the tenant-scoped source package."],
        user_id=42,
        tenant_id=42,
        internal_attribution_token="signed-scoped-attribution",
    )

    with pytest.raises(research.HTTPException) as blocked:
        research._creative_request_guard("hook_pack", grounded, grounded.topic, grounded.niche)
    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == "CONTENT_HIGH_RISK_REVIEW_REQUIRED"


@pytest.mark.parametrize(
    ("secondary_input", "expected_code"),
    [
        ("medical treatment", "CONTENT_HIGH_RISK_REVIEW_REQUIRED"),
        ("how to hack an account", "CONTENT_UNSUPPORTED_TOPIC"),
    ],
)
def test_internal_creative_guard_applies_safety_before_earlier_timely_grounding(
    secondary_input,
    expected_code,
):
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")
    request = requests.HooksRequest(
        topic="latest creator platform change today",
        niche=secondary_input,
    )

    with pytest.raises(research.HTTPException) as blocked:
        research._creative_request_guard("hook_pack", request, request.topic, request.niche)

    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == expected_code


def test_internal_creative_guard_classifies_raw_combined_field_meaning():
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")
    request = requests.HooksRequest(topic="insider", niche="trading playbook")

    with pytest.raises(research.HTTPException) as blocked:
        research._creative_request_guard("hook_pack", request, request.topic, request.niche)

    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == "CONTENT_UNSUPPORTED_TOPIC"


def test_internal_script_guard_classifies_raw_combined_field_meaning():
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")

    with pytest.raises(research.HTTPException) as blocked:
        research._script_topic_guard(requests.ScriptRequest(topic="pump", niche="and dump crypto plan"))

    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == "CONTENT_UNSUPPORTED_TOPIC"


def test_internal_creative_guard_requires_scoped_fresh_package_and_summary():
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")
    grounded = requests.HooksRequest(
        topic="current ceramics policy this month",
        source_package_id="sp_scoped_package",
        source_summary=["Current policy summary resolved by the authenticated TypeScript boundary."],
        user_id=42,
        tenant_id=42,
        internal_attribution_token="signed-scoped-attribution",
    )

    research._creative_request_guard("hook_pack", grounded, grounded.topic, grounded.niche)

    missing_package = requests.HooksRequest(
        topic="current ceramics policy this month",
        source_summary=["A summary without a package reference is not grounded."],
        user_id=42,
        tenant_id=42,
        internal_attribution_token="signed-scoped-attribution",
    )
    with pytest.raises(research.HTTPException) as blocked:
        research._creative_request_guard(
            "hook_pack",
            missing_package,
            missing_package.topic,
            missing_package.niche,
        )
    assert blocked.value.detail["error"]["code"] == "CONTENT_RESEARCH_REQUIRED"

    missing_summary = requests.HooksRequest(
        topic="current ceramics policy this month",
        source_package_id="sp_scoped_package",
        user_id=42,
        tenant_id=42,
        internal_attribution_token="signed-scoped-attribution",
    )
    with pytest.raises(research.HTTPException) as blocked:
        research._creative_request_guard(
            "hook_pack",
            missing_summary,
            missing_summary.topic,
            missing_summary.niche,
        )
    assert blocked.value.detail["error"]["code"] == "CONTENT_RESEARCH_REQUIRED"


def test_internal_creative_guard_rejects_grounding_without_scoped_attribution():
    research = importlib.import_module("routers.research")
    requests = importlib.import_module("models.requests")
    unscoped = requests.HooksRequest(
        topic="latest ibuprofen research today",
        source_package_id="sp_arbitrary",
        source_summary=["Caller-authored summary must not authorize this request."],
    )

    with pytest.raises(research.HTTPException) as blocked:
        research._creative_request_guard("hook_pack", unscoped, unscoped.topic, unscoped.niche)
    assert blocked.value.status_code == 422
    assert blocked.value.detail["error"]["code"] == "CONTENT_HIGH_RISK_REVIEW_REQUIRED"


def test_book_extract_blocks_unsafe_topics_before_ai(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    client = TestClient(main.app)

    response = client.post(
        "/api/v1/books/extract",
        json={"title": "lithium dosage research", "author": "unknown"},
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-book-risk"},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["error"]["code"] == "CONTENT_HIGH_RISK_REVIEW_REQUIRED"


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "safe\x00unsafe", "author": "A. Author"},
        {"title": "Safe Book", "author": "x" * 501},
        {"title": "Safe Book", "author": "A. Author", "language": "es-ES"},
        {"title": "Safe Book", "author": "A. Author", "creator_profile": "safe\x7funsafe"},
    ],
)
def test_book_extract_request_rejects_unbounded_or_unsupported_strings(payload):
    books = importlib.import_module("routers.books")

    with pytest.raises(ValueError):
        books.BookExtractRequest(**payload)


def test_book_extract_installs_request_attribution_context(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    books = importlib.import_module("routers.books")
    claude_client = importlib.import_module("services.claude_client")
    captured = {}

    async def fake_extract_book_with_metadata(*args, **kwargs):
        captured["context"] = claude_client._ATTRIBUTION_CONTEXT.get()
        return books.BookDNA(
            title="Tenant Manual",
            author="A. Author",
            core_thesis="Scoped.",
            key_frameworks=[],
            quotable_ideas=[],
            pillar_mapping=[],
            counter_arguments=[],
            related_thinkers=[],
            personal_notes=[],
        ), {}

    monkeypatch.setattr(books, "extract_book_with_metadata", fake_extract_book_with_metadata)
    client = TestClient(main.app)

    response = client.post(
        "/api/v1/books/extract",
        json={
            "title": "Tenant Manual",
            "author": "A. Author",
            "user_id": 7,
            "tenant_id": 44,
            "internal_attribution_token": "signed-token",
            "internal_inference_attribution_token": "signed-inference-token",
            "internal_inference_proof_key": "signed-proof-key",
        },
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-book-attribution"},
    )

    assert response.status_code == 200
    assert captured["context"] == {
        "user_id": 7,
        "tenant_id": 44,
        "attribution_token": "signed-token",
        "inference_attribution_token": "signed-inference-token",
        "inference_proof_key": "signed-proof-key",
    }


def test_hotnews_post_installs_request_attribution_context(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    research = importlib.import_module("routers.research")
    claude_client = importlib.import_module("services.claude_client")
    requests = importlib.import_module("models.requests")
    captured = {}

    class FakeOrchestrator:
        async def hot_news(self, *args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            captured["context"] = claude_client._ATTRIBUTION_CONTEXT.get()
            return requests.HotNewsResponse(topics=[], generated_at="2026-04-24T00:00:00Z")

    monkeypatch.setattr(research, "_orchestrator", FakeOrchestrator())
    client = TestClient(main.app)

    response = client.post(
        "/api/v1/hotnews",
        json={
            "language": "en-US",
            "user_id": 7,
            "tenant_id": 44,
            "internal_attribution_token": "signed-hotnews-token",
        },
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-hotnews-attribution"},
    )

    assert response.status_code == 200
    assert captured["kwargs"]["language"] == "en-US"
    assert captured["context"] == {
        "user_id": 7,
        "tenant_id": 44,
        "attribution_token": "signed-hotnews-token",
        "inference_attribution_token": None,
        "inference_proof_key": None,
    }


def test_report_post_installs_request_attribution_context(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    report_gen = importlib.import_module("services.learning.report_gen")
    claude_client = importlib.import_module("services.claude_client")
    requests = importlib.import_module("models.requests")
    captured = {}

    async def fake_generate(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        captured["context"] = claude_client._ATTRIBUTION_CONTEXT.get()
        return requests.ReportResponse(
            period="Last 7 Days",
            report={
                "status": "no_data",
                "degraded": False,
                "data_source_status": "available",
                "videos_published": None,
                "outcomes_logged": 0,
                "publication_tracking": {
                    "availability": "unavailable",
                    "reason_code": "CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED",
                    "publication_execution": "not_supported",
                },
            },
            duration_ms=1,
        )

    monkeypatch.setattr(report_gen, "generate", fake_generate)
    client = TestClient(main.app)

    response = client.post(
        "/api/v1/report",
        json={
            "period": "week",
            "user_id": 7,
            "tenant_id": 44,
            "internal_attribution_token": "signed-report-token",
        },
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-report-attribution"},
    )

    assert response.status_code == 200
    assert captured["args"][0] == "week"
    assert captured["kwargs"]["tenant_id"] == 44
    assert captured["kwargs"]["attribution_token"] == "signed-report-token"
    assert captured["context"] == {
        "user_id": 7,
        "tenant_id": 44,
        "attribution_token": "signed-report-token",
        "inference_attribution_token": None,
        "inference_proof_key": None,
    }


def test_report_post_requires_signed_tenant_attribution(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    report_gen = importlib.import_module("services.learning.report_gen")
    generate = AsyncMock()
    monkeypatch.setattr(report_gen, "generate", generate)
    client = TestClient(main.app)

    response = client.post(
        "/api/v1/report",
        json={"period": "week", "language": "en-US"},
        headers={"x-internal-secret": "valid-secret"},
    )

    assert response.status_code == 422
    generate.assert_not_awaited()


def test_ai_proxy_quota_error_preserves_public_contract(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    hook_generator = importlib.import_module("services.creative.hook_generator")
    claude_client = importlib.import_module("services.claude_client")

    async def denied(_req):
        raise claude_client.AiProxyError(
            status_code=429,
            code="AI_DAILY_LIMIT_REACHED",
            message="Daily AI quota reached.",
            details={"window": "daily", "unblocksAt": "2026-07-10T00:00:00.000Z"},
            retry_after="600",
        )

    monkeypatch.setattr(hook_generator, "generate", denied)
    client = TestClient(main.app, raise_server_exceptions=False)
    response = client.post(
        "/api/v1/hooks",
        json={"topic": "safe creator workflow"},
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-ai-quota"},
    )

    assert response.status_code == 429
    assert response.headers["retry-after"] == "600"
    assert response.json() == {
        "ok": False,
        "error": {
            "code": "AI_DAILY_LIMIT_REACHED",
            "message": "Daily AI quota reached.",
            "details": {"window": "daily", "unblocksAt": "2026-07-10T00:00:00.000Z"},
        },
    }


def test_hotnews_get_is_method_not_allowed_without_calling_orchestrator(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    research = importlib.import_module("routers.research")
    called = {"value": False}

    class FakeOrchestrator:
        async def hot_news(self, *args, **kwargs):
            called["value"] = True
            raise AssertionError("legacy GET must not invoke hot-news generation")

    monkeypatch.setattr(research, "_orchestrator", FakeOrchestrator())
    client = TestClient(main.app)

    response = client.get(
        "/api/v1/hotnews?language=en-US",
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-hotnews-attribution"},
    )

    assert response.status_code == 405
    assert response.headers["allow"] == "POST"
    assert called["value"] is False


def test_report_get_is_method_not_allowed_without_calling_generator(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    report_gen = importlib.import_module("services.learning.report_gen")
    called = {"value": False}

    async def fake_generate(*args, **kwargs):
        called["value"] = True
        raise AssertionError("legacy GET must not invoke report generation")

    monkeypatch.setattr(report_gen, "generate", fake_generate)
    client = TestClient(main.app)

    response = client.get(
        "/api/v1/report?period=week&language=en-US",
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-report-get-attribution"},
    )

    assert response.status_code == 405
    assert response.headers["allow"] == "POST"
    assert called["value"] is False


def test_production_startup_fails_without_internal_secret(monkeypatch):
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    monkeypatch.setenv("ENV", "production")
    for module_name in ("config",):
        sys.modules.pop(module_name, None)

    with pytest.raises(RuntimeError, match="INTERNAL_API_SECRET must be set"):
        importlib.import_module("config")
