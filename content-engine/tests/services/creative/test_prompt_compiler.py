from services.creative.prompt_compiler import PromptSection, compile_prompt, estimate_tokens
from services.creative.operation_prompt_compilers import (
    OperationPromptInput,
    build_operation_metadata,
    classify_operation_topic,
    compile_operation_prompt,
)


def test_prompt_compiler_caps_sections_and_reports_cacheable_prefix():
    sections = [
        PromptSection("system_policy", "Stable policy", True, True, "code", 100),
        PromptSection("creator_voice_card", "voice " * 500, True, True, "voice", 80),
        PromptSection("topic_brief", "Dynamic request", True, False, "request", 100),
    ]
    compiled = compile_prompt(
        "draft",
        sections,
    )
    compiled_again = compile_prompt("draft", sections)

    assert compiled.max_tokens == 1600
    assert compiled.cacheable_prefix_hash
    assert compiled.cacheable_prefix_hash == compiled_again.cacheable_prefix_hash
    assert compiled.token_estimate == estimate_tokens(compiled.prompt)
    voice_section = next(section for section in compiled.sections if section.section_name == "creator_voice_card")
    assert voice_section.truncated is True
    assert "[topic_brief]" in compiled.prompt


def test_prompt_compiler_uses_standard_budget_for_unknown_mode():
    compiled = compile_prompt(
        "expensive",
        [PromptSection("system_policy", "Stable policy", True, True, "code", 100)],
    )

    assert compiled.max_tokens == 3200
    assert compiled.over_budget is False


def test_operation_prompt_compiler_sets_pack_budgets_and_stable_prefix():
    compiled = compile_operation_prompt(
        OperationPromptInput(
            operation="hook_pack",
            topic="tenant-42 launch",
            language="pt-BR",
            creator_profile="Voice card: direct and practical.",
            source_summary=["Reusable source pack summary."],
        )
    )
    compiled_again = compile_operation_prompt(
        OperationPromptInput(
            operation="hook_pack",
            topic="tenant-42 launch",
            language="pt-BR",
            creator_profile="Voice card: direct and practical.",
            source_summary=["Reusable source pack summary."],
        )
    )

    assert compiled.max_tokens == 700
    assert compiled.cacheable_prefix_hash == compiled_again.cacheable_prefix_hash
    assert "[source_package]" in compiled.prompt
    assert "tenant-42 launch" in compiled.prompt


def test_operation_prompt_compiler_covers_intelligence_and_book_operations():
    cases = [
        ("title_pack", 750),
        ("caption_pack", 950),
        ("thumbnail_pack", 850),
        ("repurpose", 1900),
        ("competitor_insight", 2600),
        ("seo_insight", 2300),
        ("gap_insight", 2400),
        ("book_source", 4200),
    ]

    for operation, budget in cases:
        compiled = compile_operation_prompt(
            OperationPromptInput(
                operation=operation,
                topic="tenant-42 topic",
                creator_profile="Neutral creator profile",
                source_summary=["Compact source summary"],
                draft_context="Draft context stays capped",
            )
        )
        assert compiled.max_tokens == budget
        assert compiled.token_estimate <= compiled.max_tokens
        assert "Neutral creator profile" in compiled.prompt


def test_operation_research_router_blocks_unsupported_and_high_risk_topics_before_ai():
    assert classify_operation_topic("how to hack a competitor account")["route"] == "unsupported"
    assert classify_operation_topic("should I take ibuprofen for migraines")["route"] == "high_risk_review"
    assert classify_operation_topic("10 evergreen hooks for productivity")["route"] == "evergreen_cached"


def test_operation_research_router_covers_hostile_financial_and_pt_tax_evasion_cases():
    cases = [
        ("manipulating stock prices", "unsupported"),
        ("stock price manipulation playbook", "unsupported"),
        ("pump and dump crypto plan", "unsupported"),
        ("mei imposto evasão", "unsupported"),
        ("sonegação fiscal para MEI", "unsupported"),
        ("how to forge a passport", "unsupported"),
        ("antidepressant tapering schedule", "high_risk_review"),
        ("eating disorder recovery", "high_risk_review"),
    ]

    for topic, expected in cases:
        assert classify_operation_topic(topic)["route"] == expected


def test_operation_metadata_reports_fresh_without_real_cache_or_artifact_reuse():
    compiled = compile_operation_prompt(OperationPromptInput(operation="hook_pack", topic="evergreen hooks"))
    metadata = build_operation_metadata(object(), "hook_pack", compiled)

    assert metadata["reuse_status"] == "fresh"
    assert metadata["operation_trace"]["cacheStatus"] == "miss"
    assert metadata["operation_trace"]["cacheablePrefixReady"] is True


def test_operation_metadata_reports_reused_only_when_artifacts_are_supplied():
    class Request:
        source_package_id = "sp_1111111111111111_2222222222222222"
        voice_card_version = None
        draft_id = None
        script_id = None
        reuse_policy = None
        quality_tier = "fast"

    compiled = compile_operation_prompt(OperationPromptInput(operation="caption_pack", topic="caption topic"))
    metadata = build_operation_metadata(Request(), "caption_pack", compiled)

    assert metadata["reuse_status"] == "reused"
    assert metadata["artifact_refs"] == [
        {"type": "source_package", "id": Request.source_package_id, "source": "request"}
    ]
