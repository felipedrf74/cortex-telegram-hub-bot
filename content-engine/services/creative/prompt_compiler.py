"""Compact prompt compiler for Content generation.

The compiler keeps stable/cacheable sections first and dynamic topic/research
last so provider-native prompt caching has a fair chance to hit. It also emits
budget metadata for TS/iOS telemetry without adding a new AI framework.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re


@dataclass(frozen=True)
class PromptSection:
    section_name: str
    text: str
    required: bool
    cacheable: bool
    source: str
    max_chars: int


@dataclass(frozen=True)
class CompiledSection:
    section_name: str
    token_estimate: int
    required: bool
    cacheable: bool
    source: str
    truncated: bool


@dataclass(frozen=True)
class CompiledPrompt:
    prompt: str
    token_estimate: int
    max_tokens: int
    over_budget: bool
    cacheable_prefix_hash: str
    sections: list[CompiledSection]
    output_token_budget: int | None = None

    def metadata(self) -> dict:
        return {
            "tokenEstimate": self.token_estimate,
            "maxTokens": self.max_tokens,
            "outputTokenBudget": self.output_token_budget,
            "overBudget": self.over_budget,
            "cacheablePrefixHash": self.cacheable_prefix_hash,
            "sections": [
                {
                    "sectionName": section.section_name,
                    "tokenEstimate": section.token_estimate,
                    "required": section.required,
                    "cacheable": section.cacheable,
                    "source": section.source,
                    "truncated": section.truncated,
                }
                for section in self.sections
            ],
        }


PROMPT_BUDGETS = {
    "draft": 1600,
    "quick": 2200,
    "standard": 3200,
    "deep": 6500,
}


def estimate_tokens(value: str) -> int:
    normalized = re.sub(r"\s+", " ", value or "").strip()
    if not normalized:
        return 0
    return max(1, (len(normalized) + 3) // 4)


def _compact(value: str, max_chars: int) -> tuple[str, bool]:
    normalized = "\n".join(line.strip() for line in (value or "").replace("\r\n", "\n").split("\n") if line.strip())
    if len(normalized) <= max_chars:
        return normalized, False
    return normalized[: max(0, max_chars - 18)].rstrip() + "\n[truncated]", True


def compile_prompt(mode: str, sections: list[PromptSection]) -> CompiledPrompt:
    normalized_mode = mode if mode in PROMPT_BUDGETS else "standard"
    budget = PROMPT_BUDGETS[normalized_mode]
    rendered: list[str] = []
    cacheable: list[str] = []
    compiled_sections: list[CompiledSection] = []

    # Preserve caller order. Callers should put stable sections first.
    for section in sections:
        compacted, truncated = _compact(section.text, section.max_chars)
        if not compacted and not section.required:
            continue
        block = f"[{section.section_name}]\n{compacted}"
        rendered.append(block)
        if section.cacheable:
            cacheable.append(block)
        compiled_sections.append(
            CompiledSection(
                section_name=section.section_name,
                token_estimate=estimate_tokens(compacted),
                required=section.required,
                cacheable=section.cacheable,
                source=section.source,
                truncated=truncated,
            )
        )

    prompt = "\n\n".join(rendered)
    prefix = "\n\n".join(cacheable)
    prefix_hash = hashlib.sha256(prefix.encode("utf-8")).hexdigest()[:16]
    token_estimate = estimate_tokens(prompt)
    return CompiledPrompt(
        prompt=prompt,
        token_estimate=token_estimate,
        max_tokens=budget,
        over_budget=token_estimate > budget,
        cacheable_prefix_hash=prefix_hash,
        sections=compiled_sections,
    )
