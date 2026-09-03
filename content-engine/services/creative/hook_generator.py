"""Hook generator — creates bounded opening variants via the routed provider."""

import time
import logging
from models.requests import HookVariant, HooksRequest, HooksResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt
from services.creative.output_contracts import CreativeOutputContractError, validate_model_list

logger = logging.getLogger("content-engine.hooks")

def _build_system_prompt(req: HooksRequest) -> str:
    return f"""You are the authenticated creator's opening-variant specialist. You generate concise, topic-specific openings for the authenticated creator's content.

{creator_profile_block(req)}

HOOK RULES:
- {language_instruction(req)}
- Choose an opening mechanism that fits the topic, evidence, requested format, and saved creator voice; a curiosity gap is optional
- Never open with a generic greeting or a restatement such as "hello everyone" or "in this video"; render any copy in the requested language
- Use a different `trigger_type` label for each returned variant so the pack explores distinct opening mechanisms; the legacy field name is classification metadata, not a virality prediction
- Hooks should reflect the creator's saved brand voice and worldview from the authenticated creator memory — do NOT assume any political, religious, dietary, or ideological defaults; if the creator has not specified, keep the angle topic-driven and neutral
- Use supportable topic evidence or profile-authorized personal experience; use controversy only when the request evidence and saved creator stance support it
- Every hook MUST provide a concise suggested sound in the separate `sfx` JSON field; use `none` when no sound is justified
- Treat every variant as a bounded creative hypothesis for review; do not promise reach, retention, clicks, or ranking
- Return ONLY valid JSON, no markdown wrapping

STRUCTURAL OPENING PATTERNS (adapt to the request topic, evidence, language, and saved voice only):
- bold_claim: State one supportable outcome or tension without overstating certainty
- reaction_opener: Show the relevant source moment, pause, then add an evidence-aware creator response
- data_shock: Lead with a source-supported number only when the supplied evidence supports it
- contrarian: Present the expected interpretation, then reveal a supportable alternative
- raw_moment: Use a real creator experience only when it appears in the authenticated creator profile or request
- build_reveal: Show the result before the process only for a topic that actually contains a process or transformation
- challenge: Highlight one surprising request detail without importing a persona, catchphrase, or domain

OPENING MECHANISM LABELS (the `trigger_type` API field retains these compatibility values):
- curiosity_gap: Poses a supportable unresolved question
- bold_claim: States a strong but supportable premise
- data_shock: Uses a source-supported number or statistic
- controversy: Challenges a view only when evidence and the saved creator stance support it
- identity: Addresses an audience characteristic present in the saved profile
- urgency: References a real deadline or time-sensitive fact supplied by evidence; never manufacture FOMO
- story: Opens a profile-authorized personal narrative
- contrarian: Presents a supportable alternative interpretation
- challenge: Invites the audience to reconsider a topic-specific assumption
- build_reveal: Shows an established result before its process
- reaction_opener: Opens on a supplied source moment and evidence-aware reaction
- raw_moment: Uses a real creator experience established by the profile or request"""


class _NeutralPromptRequest:
    creator_profile = None
    brand_voice = None
    language = "en-US"


SYSTEM_PROMPT = _build_system_prompt(_NeutralPromptRequest())


def _localized_fallback_hook(req: HooksRequest) -> tuple[HookVariant, str]:
    locale = req.language.strip().lower()
    if locale.startswith("pt-br"):
        return HookVariant(
            text="O ponto mais claro e sustentado deve abrir o conteúdo.",
            trigger_type="bold_claim",
            sfx="none",
            edit_cue="none",
            score=5,
            why="Fallback conservador porque a saída do provedor não correspondeu ao contrato de hooks.",
        ), "A saída do provedor não correspondeu ao contrato de hooks; foi usado um fallback localizado."
    if locale.startswith("pt"):
        return HookVariant(
            text="O ponto mais claro e sustentado deve abrir o conteúdo.",
            trigger_type="bold_claim",
            sfx="none",
            edit_cue="none",
            score=5,
            why="Fallback conservador porque a saída do fornecedor não correspondeu ao contrato de hooks.",
        ), "A saída do fornecedor não correspondeu ao contrato de hooks; foi usado um fallback localizado."
    return HookVariant(
        text="The clearest supported point belongs at the opening.",
        trigger_type="bold_claim",
        sfx="none",
        edit_cue="none",
        score=5,
        why="Conservative fallback because the provider output did not match the hook contract.",
    ), "Provider output did not match the hook contract; a localized fallback was used."


async def generate(req: HooksRequest) -> HooksResponse:
    start = time.monotonic()
    warnings: list[str] = []
    system_prompt = _build_system_prompt(req)

    compiled = compile_operation_prompt(OperationPromptInput(
        operation="hook_pack",
        topic=req.topic,
        language=req.language,
        creator_profile=creator_profile_block(req),
        source_summary=req.source_summary,
        system_prompt=system_prompt,
        user_instruction=f"Generate {req.count} hooks for niche={req.niche}, format={req.format}.",
        format_contract=(
            'Return a JSON array of hook objects with text, trigger_type, sfx, edit_cue, score, and why. '
            'Each hook must be one concise opening beat in the requested language. Length is chosen for clarity and the requested format, '
            'within the bounded response schema; it is not a platform-ranking claim.'
        ),
    ))

    result = await ask_claude_json(
        compiled.prompt,
        system=system_prompt,
        category="content_engine_hooks",
        max_tokens=compiled.output_token_budget or 450,
    )

    try:
        hooks = validate_model_list(result, HookVariant, expected_items=req.count, wrapper_key="hooks")
        unique_triggers = {hook.trigger_type for hook in hooks}
        unique_texts = {" ".join(hook.text.casefold().split()) for hook in hooks}
        if len(unique_triggers) != len(hooks) or len(unique_texts) != len(hooks):
            raise CreativeOutputContractError("provider_output_invalid")
        degraded = False
    except CreativeOutputContractError:
        logger.warning("Hook provider output failed the bounded response contract")
        degraded = True
        fallback, warning = _localized_fallback_hook(req)
        warnings.append(warning)
        hooks = [fallback]

    duration_ms = int((time.monotonic() - start) * 1000)
    return HooksResponse(
        topic=req.topic,
        niche=req.niche,
        hooks=hooks,
        duration_ms=duration_ms,
        degraded=degraded,
        warnings=warnings,
        **build_operation_metadata(req, "hook_pack", compiled, duration_ms=duration_ms),
    )
