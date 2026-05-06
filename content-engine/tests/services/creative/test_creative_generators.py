import ast
import importlib
from pathlib import Path

import pytest
from pydantic import ValidationError

from models.requests import CaptionRequest, HooksRequest, RepurposeRequest, ThumbnailRequest, TitlesRequest


CASES = [
    (
        "hooks",
        "services.creative.hook_generator",
        lambda topic="tenant-42 launch plan": HooksRequest(topic=topic, niche="creator ops", format="Short", count=2),
        [{"text": "O detalhe que muda o plano", "trigger_type": "curiosity_gap", "score": 8, "why": "Scoped."}],
        "hooks",
        lambda: HooksRequest(topic=""),
    ),
    (
        "caption",
        "services.creative.caption_writer",
        lambda topic="tenant-42 launch plan": CaptionRequest(topic=topic, niche="creator ops", platform="Instagram"),
        {"caption": "Um plano claro vence ruido.", "hashtags": ["creatorops"]},
        "caption",
        lambda: CaptionRequest(topic=""),
    ),
    (
        "thumbnail",
        "services.creative.thumbnail_gen",
        lambda topic="tenant-42 launch plan": ThumbnailRequest(title="Launch plan", topic=topic, niche="creator ops"),
        [{"layout": "split_screen", "text_overlay": {"main_text": "Plano pronto"}, "why_it_works": "Scoped."}],
        "concepts",
        lambda: ThumbnailRequest(title=""),
    ),
    (
        "titles",
        "services.creative.title_tester",
        lambda topic="tenant-42 launch plan": TitlesRequest(topic=topic, niche="creator ops", platform="YouTube", count=2),
        [{"title": "O plano que nao quebra", "strategy": "HOW_TO", "score": 91, "why": "Grounded."}],
        "titles",
        lambda: TitlesRequest(topic=""),
    ),
    (
        "repurpose",
        "services.creative.repurpose_engine",
        lambda topic="tenant-42 launch plan": RepurposeRequest(topic=topic, original_format="YouTube"),
        [{"format": "Reel", "platform": "Instagram", "content": "Launch plan summary", "posting_delay": "+2h"}],
        "outputs",
        lambda: RepurposeRequest(topic=""),
    ),
]


def load_module(case):
    return importlib.import_module(case[1])


@pytest.mark.parametrize("case", CASES, ids=lambda case: case[0])
async def test_happy_path_returns_expected_shape(case, assert_no_founder_identity):
    module = load_module(case)
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["system"] = kwargs.get("system", "")
        return case[3]

    module.ask_claude_json = fake_ask
    if hasattr(module, "get_profile"):
        module.get_profile = lambda *args, **kwargs: "Neutral authenticated creator profile"

    response = await module.generate(case[2]())
    value = getattr(response, case[4])

    assert value
    assert response.duration_ms >= 0
    assert "tenant-42 launch plan" in captured["prompt"]
    assert "tenant-99" not in captured["prompt"]
    assert_no_founder_identity(captured["prompt"], captured.get("system", ""), value)


@pytest.mark.parametrize("case", CASES, ids=lambda case: case[0])
async def test_missing_creator_profile_stays_neutral(case, assert_no_founder_identity):
    module = load_module(case)
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["system"] = kwargs.get("system", "")
        return case[3]

    module.ask_claude_json = fake_ask
    if hasattr(module, "get_profile"):
        module.get_profile = lambda *args, **kwargs: "Neutral authenticated creator profile"

    await module.generate(case[2]("neutral request"))

    assert "authenticated creator" in f"{captured['prompt']} {captured.get('system', '')}".lower()
    assert_no_founder_identity(captured["prompt"], captured.get("system", ""))


@pytest.mark.parametrize("case", CASES, ids=lambda case: case[0])
def test_no_global_creator_profile_import(case):
    tree = ast.parse(Path(load_module(case).__file__).read_text(encoding="utf-8"))
    imported = [alias.name for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names]
    assert "_FALLBACK_PROFILE" not in imported
    assert "FALLBACK_PROFILE" not in imported


@pytest.mark.parametrize("case", CASES, ids=lambda case: case[0])
def test_invalid_required_input_is_rejected(case):
    with pytest.raises(ValidationError):
        case[5]()


@pytest.mark.parametrize("case", CASES, ids=lambda case: case[0])
async def test_ai_fault_is_not_masked_as_another_tenants_data(case):
    module = load_module(case)

    async def fake_ask(*args, **kwargs):
        raise RuntimeError("tenant-42 provider fault")

    module.ask_claude_json = fake_ask
    with pytest.raises(RuntimeError, match="tenant-42 provider fault"):
        await module.generate(case[2]())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case[0])
async def test_current_request_values_are_threaded_without_cross_tenant_leak(case):
    module = load_module(case)
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        return case[3]

    module.ask_claude_json = fake_ask
    await module.generate(case[2]("tenant-42 scoped calendar"))

    assert "tenant-42 scoped calendar" in captured["prompt"]
    assert "tenant-41" not in captured["prompt"]
    assert "tenant-99" not in captured["prompt"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case[0])
def test_static_system_prompt_has_neutral_identity_contract(case, assert_no_founder_identity):
    module = load_module(case)
    system_prompt = getattr(module, "SYSTEM_PROMPT", "")
    if case[0] == "caption":
        system_prompt = module._build_system_prompt("Neutral authenticated creator profile")
    assert "authenticated creator" in system_prompt.lower() or "authenticated user" in system_prompt.lower()
    assert_no_founder_identity(system_prompt)
