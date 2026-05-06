import ast
import builtins
import importlib
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from models.requests import DeepSearchResponse, ScriptRequest
from models.research import ContentBrief, SearchResult, SourceReference
from services import creator_profile, orchestrator
from services.creative import script_writer


SEARCHER_CASES = [
    ("web", "searchers.web", "serpapi_key"),
    ("youtube", "searchers.youtube", "youtube_api_key"),
    ("news", "searchers.news", "newsapi_key"),
    ("reddit", "searchers.reddit", "fixture_mode"),
]

TARGET_MODULES = [
    creator_profile,
    orchestrator,
    script_writer,
    *[importlib.import_module(module_path) for _, module_path, _ in SEARCHER_CASES],
]


def imported_names(module) -> list[str]:
    tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
    names: list[str] = []
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


def test_creator_profile_missing_file_uses_neutral_fallback(monkeypatch, assert_no_founder_identity):
    monkeypatch.setattr(creator_profile, "_CONFIG_PATH", "/tmp/nexus-missing-creator-profile.md")

    profile = creator_profile._load_config()

    assert "not available" in profile.lower() or "not yet configured" in profile.lower()
    assert_no_founder_identity(profile)


def test_creator_profile_reads_config_file(monkeypatch, tmp_path, assert_no_founder_identity):
    config = tmp_path / "creator-config.md"
    config.write_text("CREATOR PROFILE: tenant-42 saved voice\nAudience: private workspace", encoding="utf-8")
    monkeypatch.setattr(creator_profile, "_CONFIG_PATH", str(config))

    profile = creator_profile._load_config()

    assert "tenant-42 saved voice" in profile
    assert_no_founder_identity(profile)


def test_creator_profile_read_error_uses_neutral_fallback(monkeypatch, assert_no_founder_identity):
    def fail_open(*args, **kwargs):
        raise OSError("permission denied")

    monkeypatch.setattr(builtins, "open", fail_open)

    profile = creator_profile._load_config()

    assert "neutral" in profile.lower() or "not available" in profile.lower()
    assert_no_founder_identity(profile)


def test_creator_profile_short_mode_returns_short_value(monkeypatch):
    monkeypatch.setattr(creator_profile, "CREATOR_PROFILE_SHORT", "tenant-42 short voice")
    monkeypatch.setattr(creator_profile, "CREATOR_PROFILE", "tenant-42 long voice")

    assert creator_profile.get_profile(short=True) == "tenant-42 short voice"
    assert creator_profile.get_profile(short=False) == "tenant-42 long voice"


class StubSearcher:
    name = "stub"

    def __init__(self, *, fail: bool = False, title: str = "tenant-42 source"):
        self.fail = fail
        self.title = title
        self.calls: list[tuple[str, int]] = []

    async def search(self, query: str, max_results: int = 5):
        self.calls.append((query, max_results))
        if self.fail:
            raise RuntimeError("tenant-42 source fault")
        return [
            SearchResult(
                title=self.title,
                url=f"https://example.test/{query.replace(' ', '-')}",
                snippet=f"{query} scoped evidence",
                source=self.name,
                published_at=datetime.now(timezone.utc),
            )
        ]


async def test_orchestrator_fan_out_ignores_failed_searcher():
    ok = StubSearcher()
    failing = StubSearcher(fail=True)
    subject = orchestrator.ResearchOrchestrator(searchers=[ok, failing])

    results = await subject._fan_out("tenant-42 topic", max_per_searcher=2)

    assert [result.title for result in results] == ["tenant-42 source"]
    assert ok.calls == [("tenant-42 topic", 2)]
    assert failing.calls == [("tenant-42 topic", 2)]


async def test_orchestrator_quick_search_threads_request_topic(assert_no_founder_identity):
    subject = orchestrator.ResearchOrchestrator(searchers=[StubSearcher(title="tenant-42 launch")])

    response = await subject.quick_search("tenant-42 launch", max_results=1)

    assert response.degraded is False
    assert response.search_count == 1
    assert response.briefs[0].title == "tenant-42 launch"
    assert_no_founder_identity(response.model_dump())


async def test_orchestrator_deep_search_no_results_returns_degraded():
    class EmptySearcher:
        name = "empty"

        async def search(self, query: str, max_results: int = 5):
            return []

    subject = orchestrator.ResearchOrchestrator(searchers=[EmptySearcher()])

    response = await subject.deep_search("tenant-42 unknown", max_results=2)

    assert response.degraded is True
    assert response.briefs == []
    assert response.warnings


async def test_orchestrator_deep_search_ai_synthesis_uses_current_creator(monkeypatch, assert_no_founder_identity):
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        return {
            "summary": "tenant-42 summary",
            "key_facts": ["tenant-42 fact"],
            "creator_angle": "Use tenant-42 saved stance.",
            "arguments_for": ["scoped"],
            "arguments_against": ["needs care"],
            "content_ideas": [
                {
                    "title": "tenant-42 idea",
                    "hook": "tenant-42 hook",
                    "format": "YouTube",
                    "key_points": ["scoped point"],
                    "why_now": "tenant-42 timing",
                    "time_sensitive": False,
                }
            ],
            "best_sources": [
                {
                    "title": "source",
                    "url": "https://example.test",
                    "source_type": "web",
                    "why_useful": "scoped",
                }
            ],
        }

    monkeypatch.setattr("services.claude_client.ask_claude_json", fake_ask)
    monkeypatch.setattr(orchestrator, "get_profile", lambda short=False: "Neutral authenticated creator profile")
    subject = orchestrator.ResearchOrchestrator(searchers=[StubSearcher(title="tenant-42 research")])

    response = await subject.deep_search("tenant-42 launch", max_results=1)

    assert response.degraded is False
    assert response.briefs[0].title == "tenant-42 idea"
    assert "tenant-42 launch" in captured["prompt"]
    assert "tenant-99" not in captured["prompt"]
    assert_no_founder_identity(captured["prompt"], response.model_dump())


def research_response() -> DeepSearchResponse:
    source = SourceReference(
        title="tenant-42 source",
        url="https://example.test/source",
        source_type="web",
        relevance_note="scoped",
    )
    brief = ContentBrief(
        title="tenant-42 research",
        hook="tenant-42 hook",
        angle="scoped",
        format="YouTube",
        niche="creator ops",
        key_points=["tenant-42 proof"],
        sources=[source],
        why_now="tenant-42 reason",
    )
    return DeepSearchResponse(query="tenant-42 launch", briefs=[brief], search_count=1, duration_ms=1)


class ScriptOrchestrator:
    async def quick_search(self, *args, **kwargs):
        return research_response()

    async def deep_search(self, *args, **kwargs):
        return research_response()


async def test_script_writer_happy_path_threads_tenant_scope(monkeypatch, assert_no_founder_identity):
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["kwargs"] = kwargs
        return (
            "tenant-42 spoken script\n"
            "---METADATA---\n"
            '{"hook":"tenant-42 hook","titles":["tenant-42 title"],'
            '"hashtags":["#tenant42"],"caption":"tenant-42 caption","cta":"tenant-42 cta"}'
        )

    monkeypatch.setattr(script_writer, "ask_claude", fake_ask)
    req = ScriptRequest(
        topic="tenant-42 launch",
        creator_profile="CREATOR PROFILE: tenant-42 saved profile",
        tenant_id=42,
        user_id=42,
    )

    response = await script_writer.generate(req, ScriptOrchestrator())

    assert response.script == "tenant-42 spoken script"
    assert captured["kwargs"]["tenant_id"] == 42
    assert captured["kwargs"]["user_id"] == 42
    assert "tenant-42 launch" in captured["prompt"]
    assert "tenant-99" not in captured["prompt"]
    assert_no_founder_identity(captured["prompt"], response.model_dump())


async def test_script_writer_missing_creator_profile_degrades_neutrally(monkeypatch, assert_no_founder_identity):
    async def fail_ask(*args, **kwargs):
        raise RuntimeError("tenant-42 provider down")

    monkeypatch.setattr(script_writer, "ask_claude", fail_ask)
    req = ScriptRequest(topic="tenant-42 launch", tenant_id=42, user_id=42)

    response = await script_writer.generate(req, ScriptOrchestrator())

    assert response.degraded is True
    assert "tenant-42" in response.script.lower()
    assert_no_founder_identity(response.script, response.hook, response.caption, response.warnings)


def test_script_writer_rejects_missing_topic():
    with pytest.raises(ValidationError):
        ScriptRequest(topic="")


def test_script_writer_system_prompt_is_founder_neutral(assert_no_founder_identity):
    prompt = script_writer._build_system_prompt(ScriptRequest(topic="tenant-42 launch"))

    assert "current authenticated creator" in prompt.lower()
    assert_no_founder_identity(prompt)


@pytest.mark.parametrize("name,module_path,key", SEARCHER_CASES)
async def test_searcher_no_credentials_returns_fixture_shape(name, module_path, key, assert_no_founder_identity):
    module = importlib.import_module(module_path)
    cfg = SimpleNamespace(
        serpapi_key="",
        youtube_api_key="",
        newsapi_key="",
        fixture_mode=(name == "reddit"),
        searcher_timeout=0.1,
    )
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(module, "cfg", cfg)
    try:
        searcher_cls = getattr(module, f"{'YouTube' if name == 'youtube' else name.title()}Searcher")
        results = await searcher_cls().search("tenant-42 recovery", max_results=1)
    finally:
        monkeypatch.undo()

    assert len(results) == 1
    assert results[0].source == name
    assert "tenant-42" in f"{results[0].title} {results[0].snippet}".lower()
    assert_no_founder_identity(results[0].model_dump())


@pytest.mark.parametrize("name,module_path,key", SEARCHER_CASES)
def test_searcher_mock_respects_max_results(name, module_path, key):
    module = importlib.import_module(module_path)
    searcher_cls = getattr(module, f"{'YouTube' if name == 'youtube' else name.title()}Searcher")

    results = searcher_cls._mock("tenant-42 launch", 1)

    assert len(results) == 1
    assert results[0].source == name


@pytest.mark.parametrize("name,module_path,key", SEARCHER_CASES)
def test_searcher_evergreen_mocks_are_neutral(name, module_path, key, assert_no_founder_identity):
    module = importlib.import_module(module_path)
    searcher_cls = getattr(module, f"{'YouTube' if name == 'youtube' else name.title()}Searcher")

    results = searcher_cls._mock("tenant-42 recovery protocol", 2)

    joined = " ".join(f"{result.title} {result.snippet}" for result in results)
    assert "tenant-42" in joined.lower()
    assert "evidence" in joined.lower() or "protocol" in joined.lower() or "practical" in joined.lower()
    assert_no_founder_identity(joined)


async def test_reddit_http_fault_returns_empty(monkeypatch):
    reddit = importlib.import_module("searchers.reddit")

    class FailingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, *args, **kwargs):
            import httpx

            raise httpx.HTTPError("tenant-42 network fault")

    monkeypatch.setattr(reddit, "cfg", SimpleNamespace(fixture_mode=False, searcher_timeout=0.1))
    monkeypatch.setattr(reddit.httpx, "AsyncClient", lambda *args, **kwargs: FailingClient())

    assert await reddit.RedditSearcher().search("tenant-42 launch") == []
