from services.creative.prompt_compiler import PromptSection, compile_prompt, estimate_tokens


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
