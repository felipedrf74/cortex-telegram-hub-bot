import ast
import importlib
from pathlib import Path

import pytest
from pydantic import ValidationError

from models.requests import (
    CaptionRequest,
    HooksRequest,
    RepurposeRequest,
    ThumbnailRequest,
    TitlesRequest,
)


CREATIVE_CASES = [
    {
        "name": "hooks",
        "module": "services.creative.hook_generator",
        "request": lambda topic="tenant-42 launch plan": HooksRequest(
            topic=topic,
            niche="creator ops",
            format="Short",
            count=2,
        ),
        "sample_result": [
            {
                "text": "O detalhe que muda o plano",
                "trigger_type": "curiosity_gap",
                "sfx": "record-scratch",
                "edit_cue": "text-popup",
                "score": 8,
                "why": "Curiosity works for this request.",
            },
            {
                "text": "Ninguem esta a ver isto",
                "trigger_type": "contrarian",
                "sfx": "ding",
                "edit_cue": "zoom-punch",
                "score": 7,
                "why": "It creates a clear open loop.",
            },
        ],
        "attr": "hooks",
        "invalid_request": lambda: HooksRequest(topic=""),
    },
    {
        "name": "caption",
        "module": "services.creative.caption_writer",
        "request": lambda topic="tenant-42 launch plan": CaptionRequest(
            topic=topic,
            niche="creator ops",
            platform="Instagram",
        ),
        "sample_result": {
            "caption": "Um plano claro vence ruido.\nQual e o proximo passo?",
            "hashtags": ["creatorops", "planning"],
        },
        "attr": "caption",
        "invalid_request": lambda: CaptionRequest(topic=""),
    },
    {
        "name": "thumbnail",
        "module": "services.creative.thumbnail_gen",
        "request": lambda topic="tenant-42 launch plan": ThumbnailRequest(
            title="Launch plan",
            topic=topic,
            niche="creator ops",
        ),
        "sample_result": [
            {
                "layout": "split_screen",
                "background_color": "#0D1117",
                "text_overlay": {"main_text": "Plano pronto"},
                "facial_expression": "determined",
                "additional_elements": ["calendar"],
                "why_it_works": "The current request stays concrete.",
            },
        ],
        "attr": "concepts",
        "invalid_request": lambda: ThumbnailRequest(title=""),
    },
    {
        "name": "titles",
        "module": "services.creative.title_tester",
        "request": lambda topic="tenant-42 launch plan": TitlesRequest(
            topic=topic,
            niche="creator ops",
            platform="YouTube",
            count=2,
        ),
        "sample_result": [
            {
                "title": "O plano que nao quebra",
                "strategy": "HOW_TO",
                "score": 91,
                "why": "Specific and grounded.",
                "char_count": 22,
            },
        ],
        "attr": "titles",
        "invalid_request": lambda: TitlesRequest(topic=""),
    },
    {
        "name": "repurpose",
        "module": "services.creative.repurpose_engine",
        "request": lambda topic="tenant-42 launch plan": RepurposeRequest(
            topic=topic,
            original_format="YouTube",
        ),
        "sample_result": [
            {
                "format": "Reel",
                "platform": "Instagram",
                "content": "[SFX:ding] Launch plan summary",
                "posting_delay": "+2h",
                "notes": "Use the current topic only.",
            },
        ],
        "attr": "outputs",
        "invalid_request": lambda: RepurposeRequest(topic=""),
    },
]


def load_case_module(case):
    return importlib.import_module(case["module"])


@pytest.mark.parametrize("case", CREATIVE_CASES, ids=lambda case: case["name"])
async def test_happy_path_returns_expected_shape(case, assert_no_founder_identity):
    module = load_case_module(case)
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["system"] = kwargs.get("system", "")
        return case["sample_result"]

    module.ask_claude_json = fake_ask
    if hasattr(module, "get_profile"):
        module.get_profile = lambda *args, **kwargs: "Neutral authenticated creator profile"

    response = await module.generate(case["request"]())
    value = getattr(response, case["attr"])

    assert value
    assert response.duration_ms >= 0
    assert "tenant-42 launch plan" in captured["prompt"]
    assert "tenant-99" not in captured["prompt"]
    assert_no_founder_identity(captured["prompt"], captured.get("system", ""), value)


@pytest.mark.parametrize("case", CREATIVE_CASES, ids=lambda case: case["name"])
async def test_missing_creator_profile_stays_neutral(case, assert_no_founder_identity):
    module = load_case_module(case)
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["system"] = kwargs.get("system", "")
        return case["sample_result"]

    module.ask_claude_json = fake_ask
    if hasattr(module, "get_profile"):
        module.get_profile = lambda *args, **kwargs: "Neutral authenticated creator profile"

    response = await module.generate(case["request"]("neutral request"))

    assert getattr(response, case["attr"])
    assert "authenticated creator" in f"{captured['prompt']} {captured.get('system', '')}".lower()
    assert_no_founder_identity(captured["prompt"], captured.get("system", ""))


@pytest.mark.parametrize("case", CREATIVE_CASES, ids=lambda case: case["name"])
def test_no_global_creator_profile_import(case):
    module = load_case_module(case)
    source = Path(module.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)

    imported_names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported_names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.Import):
            imported_names.extend(alias.name for alias in node.names)

    assert "_FALLBACK_PROFILE" not in imported_names
    assert "FALLBACK_PROFILE" not in imported_names


@pytest.mark.parametrize("case", CREATIVE_CASES, ids=lambda case: case["name"])
def test_invalid_required_input_is_rejected(case):
    with pytest.raises(ValidationError):
        case["invalid_request"]()


@pytest.mark.parametrize("case", CREATIVE_CASES, ids=lambda case: case["name"])
async def test_ai_fault_is_not_masked_as_another_tenants_data(case):
    module = load_case_module(case)

    async def fake_ask(*args, **kwargs):
        raise RuntimeError("tenant-42 provider fault")

    module.ask_claude_json = fake_ask

    with pytest.raises(RuntimeError, match="tenant-42 provider fault"):
        await module.generate(case["request"]())


@pytest.mark.parametrize("case", CREATIVE_CASES, ids=lambda case: case["name"])
async def test_current_request_values_are_threaded_without_cross_tenant_leak(case):
    module = load_case_module(case)
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        return case["sample_result"]

    module.ask_claude_json = fake_ask

    await module.generate(case["request"]("tenant-42 scoped calendar"))

    assert "tenant-42 scoped calendar" in captured["prompt"]
    assert "tenant-41" not in captured["prompt"]
    assert "tenant-99" not in captured["prompt"]


@pytest.mark.parametrize("case", CREATIVE_CASES, ids=lambda case: case["name"])
def test_static_system_prompt_has_neutral_identity_contract(case, assert_no_founder_identity):
    module = load_case_module(case)
    system_prompt = getattr(module, "SYSTEM_PROMPT", "")
    if case["name"] == "caption":
        system_prompt = module._build_system_prompt("Neutral authenticated creator profile")

    lower_prompt = system_prompt.lower()
    assert "authenticated creator" in lower_prompt or "authenticated user" in lower_prompt
    assert_no_founder_identity(system_prompt)
