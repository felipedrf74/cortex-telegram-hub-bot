import logging
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from searchers import news, reddit, web, youtube
from searchers.base import resolve_search_locale
from services import orchestrator
from services.intelligence import competitor_analyzer
from services.log_redaction import SecretRedactionFilter, redact_log_message


class _FakeAsyncClient:
    def __init__(self, responses):
        self.responses = list(responses)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, *args, **kwargs):
        if not self.responses:
            raise AssertionError("no fake response queued")
        return self.responses.pop(0)


class _Response:
    def __init__(self, status_code=200, payload=None, url="https://example.test/ok"):
        self.status_code = status_code
        self.payload = payload if payload is not None else {}
        self.request = httpx.Request("GET", url)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"{self.status_code} for {self.request.url}",
                request=self.request,
                response=self,
            )

    def json(self):
        return self.payload


def _client_factory(*responses):
    return lambda *args, **kwargs: _FakeAsyncClient(responses)


def _capture_logger(monkeypatch, logger_name: str, level: int) -> list[str]:
    messages: list[str] = []

    class _MessageHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            messages.append(record.getMessage())

    logger = logging.getLogger(logger_name)
    handler = _MessageHandler()
    handler.setLevel(level)
    monkeypatch.setattr(logger, "handlers", [*logger.handlers, handler])
    monkeypatch.setattr(logger, "level", level)
    # Earlier searcher tests can populate Logger.isEnabledFor's cache while
    # the default effective level is WARNING. Directly scoping `level` for
    # this test must also scope that cache or INFO assertions become
    # order-dependent in the full Content Engine suite.
    monkeypatch.setattr(logger, "_cache", {})
    monkeypatch.setattr(logger, "disabled", False)
    monkeypatch.setattr(logger, "propagate", True)
    return messages


def test_search_locale_parser_accepts_bounded_iso_hints_only():
    assert resolve_search_locale("pt-PT") == ("pt", "PT")
    assert resolve_search_locale("en_US") == ("en", "US")
    assert resolve_search_locale("pt") == ("pt", None)
    assert resolve_search_locale("portuguese-Brazil") == (None, None)
    assert resolve_search_locale("en-US-extra") == (None, None)


async def test_search_providers_use_request_locale_without_assuming_brazil(monkeypatch):
    calls: list[dict] = []

    class _CapturingClient(_FakeAsyncClient):
        async def get(self, *args, **kwargs):
            calls.append({"args": args, "kwargs": kwargs})
            return await super().get(*args, **kwargs)

    monkeypatch.setattr(web, "cfg", SimpleNamespace(
        fixture_mode=False,
        research_network_disabled=False,
        serpapi_key="SERP_SECRET",
        searcher_timeout=10.0,
    ))
    monkeypatch.setattr(
        web.httpx,
        "AsyncClient",
        lambda *args, **kwargs: _CapturingClient([_Response(payload={"organic_results": []})]),
    )
    await web.WebSearcher().search("private query", language="pt-PT")
    assert calls[-1]["kwargs"]["params"]["hl"] == "pt"
    assert calls[-1]["kwargs"]["params"]["gl"] == "pt"

    monkeypatch.setattr(news, "cfg", SimpleNamespace(
        fixture_mode=False,
        research_network_disabled=False,
        newsapi_key="NEWS_SECRET",
        searcher_timeout=10.0,
    ))
    monkeypatch.setattr(
        news.httpx,
        "AsyncClient",
        lambda *args, **kwargs: _CapturingClient([_Response(payload={"articles": []})]),
    )
    await news.NewsSearcher().search("private query", language="en-US")
    assert calls[-1]["kwargs"]["params"]["language"] == "en"

    monkeypatch.setattr(youtube, "cfg", SimpleNamespace(
        fixture_mode=False,
        research_network_disabled=False,
        youtube_api_key="YT_SECRET",
        searcher_timeout=10.0,
    ))
    monkeypatch.setattr(
        youtube.httpx,
        "AsyncClient",
        lambda *args, **kwargs: _CapturingClient([_Response(payload={"items": []})]),
    )
    await youtube.YouTubeSearcher().search("private query", language="en-US")
    assert calls[-1]["kwargs"]["params"]["relevanceLanguage"] == "en"
    assert calls[-1]["kwargs"]["params"]["regionCode"] == "US"


async def test_web_searcher_logs_query_fingerprint_not_raw_query(monkeypatch):
    raw_query = "private tenant query about calendar and finance"
    monkeypatch.setattr(web, "cfg", SimpleNamespace(serpapi_key="SERP_SECRET", searcher_timeout=10.0))
    monkeypatch.setattr(web.httpx, "AsyncClient", _client_factory(_Response(payload={"organic_results": []})))
    messages = _capture_logger(monkeypatch, "content-engine.web", logging.INFO)

    await web.WebSearcher().search(raw_query)

    log_text = "\n".join(messages)
    assert raw_query not in log_text
    assert "query_hash=" in log_text
    assert "query_len=" in log_text


async def test_web_searcher_raises_sanitized_http_error(monkeypatch):
    raw_query = "private tenant query"
    monkeypatch.setattr(web, "cfg", SimpleNamespace(serpapi_key="SERP_SECRET", searcher_timeout=10.0))
    monkeypatch.setattr(
        web.httpx,
        "AsyncClient",
        _client_factory(_Response(503, url="https://serpapi.com/search.json?api_key=SERP_SECRET&q=private+tenant+query")),
    )
    messages = _capture_logger(monkeypatch, "content-engine.web", logging.WARNING)

    with pytest.raises(RuntimeError) as exc:
        await web.WebSearcher().search(raw_query)

    log_text = "\n".join(messages)
    _assert_no_secret_or_query(str(exc.value), log_text, "SERP_SECRET", raw_query, "api_key")
    assert "query_hash=" in log_text


async def test_news_searcher_raises_sanitized_http_error(monkeypatch):
    raw_query = "private tenant query"
    monkeypatch.setattr(news, "cfg", SimpleNamespace(newsapi_key="SECRET_NEWS_TOKEN", searcher_timeout=10.0))
    monkeypatch.setattr(
        news.httpx,
        "AsyncClient",
        _client_factory(_Response(401, url="https://newsapi.org/v2/everything?apiKey=SECRET_NEWS_TOKEN&q=private+tenant+query")),
    )
    messages = _capture_logger(monkeypatch, "content-engine.news", logging.WARNING)

    with pytest.raises(RuntimeError) as exc:
        await news.NewsSearcher().search(raw_query)

    log_text = "\n".join(messages)
    _assert_no_secret_or_query(str(exc.value), log_text, "SECRET_NEWS_TOKEN", raw_query, "apiKey")
    assert "query_hash=" in log_text


async def test_youtube_searcher_sanitizes_search_http_error(monkeypatch):
    raw_query = "private tenant youtube query"
    monkeypatch.setattr(youtube, "cfg", SimpleNamespace(youtube_api_key="YT_SECRET", searcher_timeout=10.0))
    monkeypatch.setattr(
        youtube.httpx,
        "AsyncClient",
        _client_factory(_Response(403, url="https://www.googleapis.com/youtube/v3/search?key=YT_SECRET&q=private+tenant+youtube+query")),
    )
    messages = _capture_logger(monkeypatch, "content-engine.youtube", logging.WARNING)

    with pytest.raises(RuntimeError) as exc:
        await youtube.YouTubeSearcher().search(raw_query)

    log_text = "\n".join(messages)
    _assert_no_secret_or_query(str(exc.value), log_text, "YT_SECRET", raw_query, "key=")
    assert "query_hash=" in log_text


async def test_youtube_searcher_sanitizes_stats_http_error(monkeypatch):
    raw_query = "private tenant youtube query"
    search_payload = {
        "items": [{
            "id": {"videoId": "video123456"},
            "snippet": {
                "title": "safe title",
                "description": "",
                "publishedAt": "2026-01-01T00:00:00Z",
                "thumbnails": {},
            },
        }],
    }
    monkeypatch.setattr(youtube, "cfg", SimpleNamespace(youtube_api_key="YT_SECRET", searcher_timeout=10.0))
    monkeypatch.setattr(
        youtube.httpx,
        "AsyncClient",
        _client_factory(
            _Response(payload=search_payload),
            _Response(403, url="https://www.googleapis.com/youtube/v3/videos?key=YT_SECRET&id=video123456"),
        ),
    )
    messages = _capture_logger(monkeypatch, "content-engine.youtube", logging.WARNING)

    with pytest.raises(RuntimeError) as exc:
        await youtube.YouTubeSearcher().search(raw_query)

    log_text = "\n".join(messages)
    _assert_no_secret_or_query(str(exc.value), log_text, "YT_SECRET", raw_query, "key=")
    assert "query_hash=" in log_text


@pytest.mark.parametrize(
    ("stage", "responses"),
    [
        (
            "channel_search",
            [_Response(403, url="https://www.googleapis.com/youtube/v3/search?key=YT_SECRET&q=private+competitor+channel")],
        ),
        (
            "video_search",
            [
                _Response(payload={"items": [{"id": {"channelId": "channel-1"}, "snippet": {"channelTitle": "Private Channel"}}]}),
                _Response(403, url="https://www.googleapis.com/youtube/v3/search?key=YT_SECRET&channelId=channel-1"),
            ],
        ),
        (
            "video_stats",
            [
                _Response(payload={"items": [{"id": {"channelId": "channel-1"}, "snippet": {"channelTitle": "Private Channel"}}]}),
                _Response(payload={"items": [{"id": {"videoId": "video123456"}, "snippet": {"title": "Video", "publishedAt": "2026-01-01T00:00:00Z"}}]}),
                _Response(403, url="https://www.googleapis.com/youtube/v3/videos?key=YT_SECRET&id=video123456"),
            ],
        ),
    ],
)
async def test_competitor_analyzer_sanitizes_youtube_http_errors(monkeypatch, stage, responses):
    raw_query = "private competitor channel"
    monkeypatch.setattr(competitor_analyzer, "cfg", SimpleNamespace(youtube_api_key="YT_SECRET"))
    monkeypatch.setattr(competitor_analyzer.httpx, "AsyncClient", _client_factory(*responses))
    messages = _capture_logger(monkeypatch, "content-engine.competitor", logging.WARNING)

    with pytest.raises(RuntimeError) as exc:
        await competitor_analyzer._fetch_channel_videos(raw_query, 5)

    log_text = "\n".join(messages)
    _assert_no_secret_or_query(str(exc.value), log_text, "YT_SECRET", raw_query, "key=")
    assert f"stage={stage}" in log_text
    assert "input_hash=" in log_text


async def test_reddit_searcher_logs_query_fingerprint_not_raw_query(monkeypatch):
    raw_query = "private reddit query"
    monkeypatch.setattr(reddit, "cfg", SimpleNamespace(fixture_mode=False, searcher_timeout=10.0))
    monkeypatch.setattr(reddit.httpx, "AsyncClient", _client_factory(_Response(payload={"data": {"children": []}})))
    messages = _capture_logger(monkeypatch, "content-engine.reddit", logging.INFO)

    await reddit.RedditSearcher().search(raw_query)

    log_text = "\n".join(messages)
    assert raw_query not in log_text
    assert "query_hash=" in log_text


def test_orchestrator_variation_failure_logging_uses_query_fingerprint():
    source = Path(orchestrator.__file__).read_text(encoding="utf-8")
    assert "Search variation failed for '%s'" not in source
    assert "Search variation failed (query_hash=%s query_len=%d error_type=%s)" in source


def test_secret_redaction_filter_scrubs_planted_log_line():
    message = "request failed api_key=SECRET_ONE&key=SECRET_TWO apiKey=SECRET_THREE Authorization: Bearer SECRET_TOKEN"
    redacted = redact_log_message(message)
    assert "SECRET_ONE" not in redacted
    assert "SECRET_TWO" not in redacted
    assert "SECRET_THREE" not in redacted
    assert "SECRET_TOKEN" not in redacted
    assert "api_key=<redacted>" in redacted
    assert "key=<redacted>" in redacted
    assert "apiKey=<redacted>" in redacted
    assert "Bearer <redacted>" in redacted

    record = logging.LogRecord("uvicorn.error", logging.WARNING, __file__, 1, message, (), None)
    assert SecretRedactionFilter().filter(record) is True
    assert "SECRET_TOKEN" not in record.getMessage()


def _assert_no_secret_or_query(error_text: str, log_text: str, secret: str, raw_query: str, url_key_name: str) -> None:
    assert secret not in error_text
    assert raw_query not in error_text
    assert url_key_name not in error_text
    assert secret not in log_text
    assert raw_query not in log_text
