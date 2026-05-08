import pytest

from models.requests import (
    CompetitorRequest,
    FeedbackRequest,
    HooksRequest,
    RepurposeRequest,
    SeoRequest,
    ThumbnailRequest,
    TitlesRequest,
)
from services import book_knowledge
from services.creative import hook_generator, repurpose_engine, thumbnail_gen, title_tester
from services.intelligence import competitor_analyzer, seo_engine
from services.learning import feedback_loop, report_gen


NON_FOUNDER_PROFILE = (
    "Language: en-US\n"
    "Audience: 25-45 women\n"
    "Pillars: knitting, sustainable home crafts\n"
    "Voice: calm, practical, encouraging"
)

FORBIDDEN_TOKENS = [
    "pt-BR",
    "PT-BR",
    "Portuguese",
    "18-40",
    "faith",
    "carnivore",
    "Austrian",
    "Felipe",
    "Jaqueline",
]


def assert_clean_prompt(prompt: str, system: str = "") -> None:
    combined = f"{prompt}\n{system}"
    for token in FORBIDDEN_TOKENS:
        assert token not in combined
    assert "en-US" in combined
    assert "25-45 women" in combined
    assert "knitting" in combined


async def capture_json(monkeypatch, module, response):
    captured = {}

    async def fake_ask(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["system"] = kwargs.get("system", "")
        return response

    monkeypatch.setattr(module, "ask_claude_json", fake_ask)
    return captured


@pytest.mark.parametrize(
    ("module", "content_request", "response"),
    [
        (
            hook_generator,
            HooksRequest(topic="spring cardigan launch", creator_profile=NON_FOUNDER_PROFILE, language="en-US"),
            [{"text": "A simple cardigan secret", "trigger_type": "curiosity_gap", "score": 8, "why": "Scoped"}],
        ),
        (
            repurpose_engine,
            RepurposeRequest(topic="spring cardigan launch", creator_profile=NON_FOUNDER_PROFILE, language="en-US"),
            [{"format": "Reel", "platform": "Instagram", "content": "Cardigan tip", "posting_delay": "+2h"}],
        ),
        (
            title_tester,
            TitlesRequest(topic="spring cardigan launch", creator_profile=NON_FOUNDER_PROFILE, language="en-US"),
            [{"title": "A cardigan that actually fits", "strategy": "HOW_TO", "score": 90, "why": "Scoped"}],
        ),
        (
            thumbnail_gen,
            ThumbnailRequest(title="Cardigan fit guide", topic="spring cardigan launch", creator_profile=NON_FOUNDER_PROFILE, language="en-US"),
            [{"layout": "close_up", "text_overlay": {"main_text": "Perfect Fit"}, "why_it_works": "Scoped"}],
        ),
    ],
)
async def test_creative_prompts_use_request_profile_without_founder_defaults(monkeypatch, module, content_request, response):
    captured = await capture_json(monkeypatch, module, response)

    await module.generate(content_request)

    assert_clean_prompt(captured["prompt"], captured["system"])


async def test_seo_prompt_uses_request_profile_without_founder_defaults(monkeypatch):
    captured = await capture_json(monkeypatch, seo_engine, [{"keyword": "cardigan", "opportunity_score": 8}])

    class Orchestrator:
        async def _fan_out(self, *_args, **_kwargs):
            return []

    await seo_engine.analyze(
        SeoRequest(topic="spring cardigan launch", creator_profile=NON_FOUNDER_PROFILE, language="en-US"),
        Orchestrator(),
    )

    assert_clean_prompt(captured["prompt"], captured["system"])


async def test_competitor_prompt_uses_request_profile_without_founder_defaults(monkeypatch):
    captured = await capture_json(monkeypatch, competitor_analyzer, {"channel": "crafts"})

    async def fake_videos(*_args, **_kwargs):
        return []

    monkeypatch.setattr(competitor_analyzer, "_fetch_channel_videos", fake_videos)

    await competitor_analyzer.analyze(
        CompetitorRequest(channel="craft channel", creator_profile=NON_FOUNDER_PROFILE, language="en-US"),
    )

    assert_clean_prompt(captured["prompt"], captured["system"])


async def test_feedback_prompt_uses_request_profile_without_founder_defaults(monkeypatch):
    captured = await capture_json(monkeypatch, feedback_loop, {"performance_level": "above_average"})

    await feedback_loop.log_and_analyze(
        FeedbackRequest(
            video_url="https://example.test/video",
            views=1200,
            retention_pct=61,
            creator_profile=NON_FOUNDER_PROFILE,
            language="en-US",
        ),
    )

    assert_clean_prompt(captured["prompt"], captured["system"])


async def test_report_prompt_uses_request_profile_without_founder_defaults(monkeypatch):
    captured = await capture_json(monkeypatch, report_gen, {"videos_published": 1})

    async def fake_history(_days):
        return [{"views": 1000, "retentionPct": 60, "likes": 50, "comments": 4, "subsGained": 3, "hookUsed": "calm hook"}]

    monkeypatch.setattr(report_gen, "_fetch_performance_history", fake_history)

    await report_gen.generate("week", creator_profile=NON_FOUNDER_PROFILE, language="en-US")

    assert_clean_prompt(captured["prompt"], captured["system"])


async def test_book_prompt_uses_request_profile_without_founder_defaults(monkeypatch):
    captured = await capture_json(monkeypatch, book_knowledge, {
        "title": "Needlework",
        "author": "A. Maker",
        "core_thesis": "Craft with care.",
        "key_frameworks": [],
        "quotable_ideas": [],
        "pillar_mapping": ["knitting"],
        "counter_arguments": [],
        "related_thinkers": [],
        "personal_notes": [],
    })

    async def fake_search(*_args, **_kwargs):
        return [{"title": "Knitting book", "snippet": "About sustainable craft", "link": "https://example.test"}]

    monkeypatch.setattr(book_knowledge, "_web_search", fake_search)

    await book_knowledge.extract_book(
        "Needlework",
        "A. Maker",
        creator_profile=NON_FOUNDER_PROFILE,
        language="en-US",
    )

    assert_clean_prompt(captured["prompt"], captured["system"])
