"""Operation-specific prompt compilers for Content packs and intelligence.

These helpers keep non-script Content endpoints on the same token-economy
contract as script generation: stable policy/schema/voice first, dynamic
topic/source context last, and a small explicit budget per operation.
"""

from __future__ import annotations

from dataclasses import dataclass
import re

from services.creative.prompt_compiler import CompiledPrompt, PromptSection, compile_prompt


@dataclass(frozen=True)
class OperationPromptInput:
    operation: str
    topic: str
    language: str = "en-US"
    creator_profile: str = ""
    source_summary: list[str] | None = None
    draft_context: str = ""
    user_instruction: str = ""
    format_contract: str = ""


OPERATION_BUDGETS: dict[str, tuple[str, int]] = {
    "hook_pack": ("draft", 700),
    "title_pack": ("draft", 750),
    "caption_pack": ("draft", 950),
    "thumbnail_pack": ("draft", 850),
    "cta_pack": ("draft", 650),
    "shorts_cutdown": ("quick", 1500),
    "repurpose": ("quick", 1900),
    "competitor_insight": ("standard", 2600),
    "seo_insight": ("standard", 2300),
    "gap_insight": ("standard", 2400),
    "book_source": ("deep", 4200),
}

OPERATION_COST_TIER: dict[str, str] = {
    "hook_pack": "low",
    "title_pack": "low",
    "caption_pack": "low",
    "thumbnail_pack": "low",
    "cta_pack": "low",
    "shorts_cutdown": "medium",
    "repurpose": "medium",
    "competitor_insight": "medium",
    "seo_insight": "medium",
    "gap_insight": "medium",
    "book_source": "high",
}


UNSUPPORTED_TOPIC_RE = re.compile(
    r"\b("
    # Direct unsafe actions (EN)
    r"hack|hacking|steal|stolen|stealing|phishing|malware|exploit|exploiting|"
    r"piracy|pirated|crack|cracking|bypass|credential|credentials|"
    # 2026-05-18 phase2-qa P1: expanded EN coverage
    r"ddos|dox|doxx|doxxing|stalk|stalking|harassment|harass|"
    r"insider[- ]trading|plagiariz(?:e|ing)|plagiarism|copyright[- ]violat(?:e|ion)|"
    r"market[- ]manipulation|manipulat(?:e|ing)[- ](?:stock|market|prices?)|"
    r"stock[- ]price[- ]manipulation|pump[- ]and[- ]dump|tax[- ]evasion|"
    r"counterfeit|fraud|forgery|forge|deepfake|revenge[- ]porn|csam|cp(?:\b|orn)|"
    r"suicide[- ](?:method|how)|self[- ]harm[- ](?:method|how|guide)|"
    # Portuguese
    r"roubar|invadir|pirataria|crackear|invas[aã]o|fraude|fraudar|"
    r"evas[aã]o|evasao|sonega[cç][aã]o|sonegacao|manipula[cç][aã]o[- ](?:de[- ])?mercado|"
    r"perseguir|ass[ée]dio|falsific[ae]r|plagiar"
    r")\b",
    re.IGNORECASE,
)

HIGH_RISK_TOPIC_RE = re.compile(
    r"\b("
    # Medical / pharma / mental-health (EN)
    r"medical|medicine|doctor|diagnosis|treatment|dose|dosage|"
    r"ibuprofen|paracetamol|acetaminophen|aspirin|lithium|antidepressant|"
    r"prozac|zoloft|xanax|adderall|ritalin|opioid|opiate|"
    r"migraine|depression|anxiety|panic[- ]attack|bipolar|psychosis|"
    r"blood[- ]pressure|hypertension|cholesterol|diabetes|insulin|"
    r"pregnan(?:t|cy)|miscarriage|abortion|menopause|"
    r"suicide|suicidal|self[- ]harm|eating[- ]disorder|anorexia|bulimia|"
    r"fasting|diet|keto|carnivore[- ]medical|"
    r"vaccine[- ](?:truth|conspiracy|danger|skeptic)|covid[- ](?:truth|conspiracy)|"
    # Legal / financial (EN)
    r"legal|lawsuit|sue|sued|litigation|"
    r"tax(?:[- ]advice|[- ]evasion)?|investment[- ]advice|financial[- ]advice|"
    r"securities|stock[- ]tip|crypto[- ]advice|tax[- ]shelter|"
    r"therapy|psychiatr(?:y|ist|ic)|prescription|"
    # Portuguese
    r"medicamento|dosagem|enxaqueca|"
    r"depress[aã]o|ansiedade|press[aã]o[- ]arterial|"
    r"jejum|dieta|jur[ií]dico|judicial|advogado|advocacia|"
    r"imposto|investimento|conselho[- ]financeiro|"
    r"su[ií]cidio|suicidar|automutila[cç][aã]o|terapia|tratamento|"
    r"gravidez|aborto|menopausa"
    r")\b",
    re.IGNORECASE,
)


def classify_operation_topic(topic: str) -> dict[str, str]:
    """Cheap research/safety router for non-script Content operations.

    Unsupported and high-risk topics should stop before creative pack endpoints
    spend tokens. Script generation has its own richer TypeScript gate.
    """
    normalized = (topic or "").strip()
    if not normalized:
        return {"route": "creator_only", "reason": "empty_topic"}
    if UNSUPPORTED_TOPIC_RE.search(normalized):
        return {"route": "unsupported", "reason": "unsafe_or_abusive_topic"}
    if HIGH_RISK_TOPIC_RE.search(normalized):
        return {"route": "high_risk_review", "reason": "high_risk_topic_requires_source_grounding"}
    timely = re.search(r"\b(today|latest|this week|202[6-9]|agora|hoje|últim[oa]|ultima|not[ií]cia)\b", normalized, re.IGNORECASE)
    return {
        "route": "fresh_compact" if timely else "evergreen_cached",
        "reason": "timely_topic" if timely else "evergreen_topic",
    }


def compile_operation_prompt(input: OperationPromptInput) -> CompiledPrompt:
    mode, budget = OPERATION_BUDGETS.get(input.operation, ("standard", 1800))
    source_summary = "\n".join(f"- {line.strip()[:220]}" for line in (input.source_summary or []) if line.strip())
    sections = [
        PromptSection(
            "system_policy",
            "Nexus Content operation. Reuse supplied artifacts. Do not rerun research or invent sources. Return user-safe output only.",
            True,
            True,
            "code",
            700,
        ),
        PromptSection(
            "output_contract",
            _schema_for(input.operation),
            True,
            True,
            "schema",
            850,
        ),
        PromptSection(
            "creator_voice_card",
            input.creator_profile or "No creator profile supplied. Use a neutral topic-led voice.",
            True,
            True,
            "voice",
            1100,
        ),
        PromptSection(
            "topic_brief",
            f"Operation: {input.operation}\nTopic: {input.topic}\nLanguage: {input.language}\nInstruction: {input.user_instruction}".strip(),
            True,
            False,
            "request",
            900,
        ),
        PromptSection(
            "source_package",
            source_summary or "No source package supplied. Avoid factual claims requiring citations.",
            False,
            False,
            "retrieval",
            900 if input.operation != "book_source" else 1800,
        ),
        PromptSection(
            "draft_context",
            input.draft_context,
            False,
            False,
            "request",
            1400,
        ),
        PromptSection(
            "format_contract",
            input.format_contract or _format_contract_for(input.operation),
            True,
            False,
            "schema",
            800,
        ),
    ]
    compiled = compile_prompt(mode, sections)
    return CompiledPrompt(
        prompt=compiled.prompt,
        token_estimate=compiled.token_estimate,
        max_tokens=budget,
        over_budget=compiled.token_estimate > budget,
        cacheable_prefix_hash=compiled.cacheable_prefix_hash,
        sections=compiled.sections,
    )


def build_operation_metadata(req, operation: str, compiled: CompiledPrompt) -> dict:
    """Shared response metadata for token-aware Content operations."""
    source_package_id = getattr(req, "source_package_id", None)
    voice_card_version = getattr(req, "voice_card_version", None)
    draft_id = getattr(req, "draft_id", None)
    script_id = getattr(req, "script_id", None)
    artifact_refs = []
    if source_package_id:
        artifact_refs.append({"type": "source_package", "id": source_package_id, "source": "request"})
    if voice_card_version:
        artifact_refs.append({"type": "voice_card", "id": voice_card_version, "source": "request"})
    if draft_id:
        artifact_refs.append({"type": "draft", "id": draft_id, "source": "request"})
    if script_id:
        artifact_refs.append({"type": "script", "id": script_id, "source": "request"})

    reuse_status = "reused" if artifact_refs else "fresh"
    if getattr(req, "reuse_policy", None) == "force_refresh":
        reuse_status = "refreshed"
    elif getattr(req, "reuse_policy", None) == "no_research":
        reuse_status = "reused" if artifact_refs else "fresh"

    return {
        "operation_trace": {
            "operation": operation,
            "provider": "content-engine",
            "model": "provider-routed",
            "inputTokens": compiled.token_estimate,
            "outputTokenBudget": compiled.max_tokens,
            "cacheStatus": "miss",
            "cacheablePrefixHash": compiled.cacheable_prefix_hash,
            "cacheablePrefixReady": bool(compiled.cacheable_prefix_hash),
            "latencyMs": None,
        },
        "artifact_refs": artifact_refs,
        "next_actions": _next_actions_for(operation),
        "reuse_status": reuse_status,
        "cost_tier": OPERATION_COST_TIER.get(operation, "medium"),
        "quality_report": {
            "tier": getattr(req, "quality_tier", None) or "fast",
            "warnings": ["prompt_over_budget"] if compiled.over_budget else [],
        },
        "claim_ledger": [],
        "agent_signals_used": [],
    }


def _next_actions_for(operation: str) -> list[dict]:
    if operation in {"hook_pack", "title_pack", "caption_pack", "thumbnail_pack"}:
        return [
            {"id": "generate_draft", "label": "Generate draft", "kind": "draft", "costTier": "medium"},
            {"id": "refresh_research", "label": "Refresh research", "kind": "research_refresh", "costTier": "high"},
        ]
    if operation == "repurpose":
        return [{"id": "rewrite_tone", "label": "Rewrite tone", "kind": "rewrite", "costTier": "low"}]
    if operation in {"competitor_insight", "seo_insight", "gap_insight"}:
        return [{"id": "turn_into_draft", "label": "Turn into draft", "kind": "draft", "costTier": "medium"}]
    if operation == "book_source":
        return [{"id": "create_script_from_reference", "label": "Create script from reference", "kind": "draft", "costTier": "medium"}]
    return []


def _schema_for(operation: str) -> str:
    return {
        "hook_pack": '{"hooks":[{"text":"","pattern":"","risk":"","why":""}],"qualityWarnings":[]}',
        "title_pack": '{"titles":[{"title":"","label":"","why":""}],"qualityWarnings":[]}',
        "caption_pack": '{"captions":[{"platform":"","caption":"","cta":""}],"qualityWarnings":[]}',
        "thumbnail_pack": '{"concepts":[{"visual":"","thumbnailText":"","composition":"","promise":""}],"qualityWarnings":[]}',
        "cta_pack": '{"ctas":[{"style":"","text":"","bestFor":""}],"qualityWarnings":[]}',
        "shorts_cutdown": '{"beats":[{"timebox":"","line":"","visual":""}],"qualityWarnings":[]}',
        "repurpose": '{"outputs":[{"format":"","platform":"","content":"","posting_delay":"","notes":""}],"qualityWarnings":[]}',
        "competitor_insight": '{"patterns":[],"gaps":[],"moves":[],"qualityWarnings":[]}',
        "seo_insight": '{"clusters":[{"keyword":"","intent":"","opportunity":""}],"qualityWarnings":[]}',
        "gap_insight": '{"gaps":[{"topic":"","angle":"","whyNow":""}],"qualityWarnings":[]}',
        "book_source": '{"referenceDna":{"thesis":"","frameworks":[],"claimBoundaries":[],"contentAngles":[]},"qualityWarnings":[]}',
    }.get(operation, '{"result":{},"qualityWarnings":[]}')


def _format_contract_for(operation: str) -> str:
    return {
        "hook_pack": "8-12 hooks grouped by pattern; flag repeated or risky angles.",
        "title_pack": "10 titles with clarity/search/curiosity labels; no unsupported clickbait.",
        "caption_pack": "Short, medium, LinkedIn, Instagram, and CTA variants in the requested language.",
        "thumbnail_pack": "3-5 visual concepts with thumbnail text, composition, and emotional promise.",
        "repurpose": "Chunk by target platform. Reuse the draft/source package instead of restating the full script.",
        "competitor_insight": "Use summarized competitor data only; identify patterns and gaps.",
        "seo_insight": "Use summarized keyword data only; return compact clusters.",
        "gap_insight": "Use summarized demand/supply data only; return compact opportunities.",
        "book_source": "Extract reusable ReferenceDNA once; avoid future full source dumps.",
    }.get(operation, "Keep output compact, grounded, and reusable.")
