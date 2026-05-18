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


def test_production_startup_fails_without_internal_secret(monkeypatch):
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    monkeypatch.setenv("ENV", "production")
    for module_name in ("config",):
        sys.modules.pop(module_name, None)

    with pytest.raises(RuntimeError, match="INTERNAL_API_SECRET must be set"):
        importlib.import_module("config")

