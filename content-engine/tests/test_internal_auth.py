import importlib
import sys

import pytest
from fastapi.testclient import TestClient


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
    ("path", "payload", "expected_code"),
    [
        ("/api/v1/hooks", {"topic": "how to hack a competitor account"}, "CONTENT_UNSUPPORTED_TOPIC"),
        ("/api/v1/script", {"topic": "how to hack a competitor account"}, "CONTENT_UNSUPPORTED_TOPIC"),
        ("/api/v1/caption", {"topic": "should I take ibuprofen for migraines"}, "CONTENT_HIGH_RISK_REVIEW_REQUIRED"),
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
    }


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
        },
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-book-attribution"},
    )

    assert response.status_code == 200
    assert captured["context"] == {
        "user_id": 7,
        "tenant_id": 44,
        "attribution_token": "signed-token",
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
        return requests.ReportResponse(period="Last 7 Days", report={"ok": True}, duration_ms=1)

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
    }


def test_hotnews_get_installs_empty_attribution_context(monkeypatch):
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

    response = client.get(
        "/api/v1/hotnews?language=en-US",
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-hotnews-attribution"},
    )

    assert response.status_code == 200
    assert captured["kwargs"]["language"] == "en-US"
    assert captured["context"] == {
        "user_id": None,
        "tenant_id": None,
        "attribution_token": None,
    }


def test_report_get_installs_empty_attribution_context(monkeypatch):
    main = _reload_content_engine(monkeypatch, secret="valid-secret")
    report_gen = importlib.import_module("services.learning.report_gen")
    claude_client = importlib.import_module("services.claude_client")
    requests = importlib.import_module("models.requests")
    captured = {}

    async def fake_generate(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        captured["context"] = claude_client._ATTRIBUTION_CONTEXT.get()
        return requests.ReportResponse(period="Last 7 Days", report={"ok": True}, duration_ms=1)

    monkeypatch.setattr(report_gen, "generate", fake_generate)
    client = TestClient(main.app)

    response = client.get(
        "/api/v1/report?period=week&language=en-US",
        headers={"x-internal-secret": "valid-secret", "x-request-id": "req-report-get-attribution"},
    )

    assert response.status_code == 200
    assert captured["args"][0] == "week"
    assert captured["kwargs"]["language"] == "en-US"
    assert captured["context"] == {
        "user_id": None,
        "tenant_id": None,
        "attribution_token": None,
    }


def test_production_startup_fails_without_internal_secret(monkeypatch):
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    monkeypatch.setenv("ENV", "production")
    for module_name in ("config",):
        sys.modules.pop(module_name, None)

    with pytest.raises(RuntimeError, match="INTERNAL_API_SECRET must be set"):
        importlib.import_module("config")
