"""Bounded trust-boundary envelopes for provider prompts."""


def neutralize_untrusted_prompt_data(value: str) -> str:
    without_unsafe_controls = "".join(
        " " if (ord(character) < 32 and character not in {"\n", "\t"}) or ord(character) == 127 else character
        for character in value
    )
    return (
        without_unsafe_controls
        .replace("<", "‹")
        .replace(">", "›")
        .replace("[", "［")
        .replace("]", "］")
    )


def bounded_untrusted_prompt_block(value: str, marker: str, preface: str, max_chars: int) -> str:
    prefix = f"{preface}\n<{marker}>\n"
    suffix = f"\n</{marker}>"
    if max_chars <= len(prefix) + len(suffix):
        raise ValueError("untrusted prompt envelope is smaller than its mandatory boundary")
    safe_value = neutralize_untrusted_prompt_data(value)
    available = max_chars - len(prefix) - len(suffix)
    return f"{prefix}{safe_value[:available]}{suffix}"
