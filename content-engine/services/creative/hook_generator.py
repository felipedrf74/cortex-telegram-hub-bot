"""
Hook generator — creates scroll-stopping hooks using Claude + seed templates.

Hooks are the first 3 seconds of a video / first line of a post.
They must create an open loop (curiosity gap) that compels the viewer to stay.
"""

import time
import logging
from models.requests import HooksRequest, HooksResponse
from services.claude_client import ask_claude_json
from services.creator_context import creator_profile_block, language_instruction

logger = logging.getLogger("content-engine.hooks")

def _build_system_prompt(req: HooksRequest) -> str:
    return f"""You are the authenticated creator's viral hook specialist. You generate scroll-stopping hooks for the authenticated creator's content.

{creator_profile_block(req)}

HOOK RULES:
- {language_instruction(req)}
- Every hook must create a CURIOSITY GAP (open loop)
- Never start with "Olá pessoal" or "Neste vídeo" — those are anti-hooks
- Each hook should use a different viral trigger type
- Hooks should reflect the creator's saved brand voice and worldview from the authenticated creator memory — do NOT assume any political, religious, dietary, or ideological defaults; if the creator has not specified, keep the angle topic-driven and neutral
- Use data, controversy, or personal experience — never empty clickbait
- Every hook MUST include a suggested [SFX:...] marker
- Return ONLY valid JSON, no markdown wrapping

OPERATOR HOOK FORMULAS:
- bold_claim (The Build Flex): "Eu construí uma IA que [absurd capability]." [SFX:vine-boom]
- reaction_opener: [Play 2s of shocking content] → [PAUSE] → [EDIT:deadpan-stare] → [SFX:metal-pipe]
- stat_bomb: "[Number] [units]." [Each number gets its own zoom + SFX:vine-boom]
- subversion: "Ele tem razão—" [SFX:record-scratch] "Claro que não."
- raw_moment (The Suffer): [Mid-training suffering] → [EDIT:zoom-punch into face] → [SFX:fahhh]
- build_reveal: [Show finished product first] → "E eu fiz isso com [tool]." [SFX:vine-boom]
- callout: [SFX:among-us] "Espera. Ele acabou de dizer o quê?"

VIRAL TRIGGER TYPES:
- curiosity_gap: Creates an open loop the viewer must close
- bold_claim: Makes a strong statement that demands attention
- data_shock: Uses a surprising number or statistic
- controversy: Challenges a popular belief or mainstream narrative
- identity: Makes the creator's saved target audience think "that's me"
- urgency: Creates FOMO or time pressure
- story: Opens a personal narrative
- contrarian: Goes against what everyone else is saying
- challenge: Dares the viewer to rethink something
- build_reveal: Shows the finished product before the process
- reaction_opener: Raw first-reaction energy to shocking content
- raw_moment: Authentic unfiltered life moment"""


class _NeutralPromptRequest:
    creator_profile = None
    brand_voice = None
    language = "en-US"


SYSTEM_PROMPT = _build_system_prompt(_NeutralPromptRequest())


async def generate(req: HooksRequest) -> HooksResponse:
    start = time.monotonic()
    warnings: list[str] = []

    prompt = f"""Generate {req.count} unique hooks for the following:
- Topic: {req.topic}
- Niche: {req.niche}
- Format: {req.format}

These hooks are for the authenticated creator's saved target audience (use the saved audience profile; do not assume a default demographic). They should sound in the authenticated creator's saved brand voice and tone.

For each hook, provide:
1. "text": the hook text in the requested language (max 15 words, conversational)
2. "trigger_type": which viral trigger it uses (use Operator Hook Formulas when applicable)
3. "sfx": suggested SFX marker (e.g. "vine-boom", "metal-pipe", "fahhh", "record-scratch", "among-us")
4. "edit_cue": suggested edit technique (e.g. "zoom-punch", "deadpan-stare", "speed-ramp", "text-popup")
5. "score": estimated effectiveness 1-10
6. "why": one sentence explaining why this hook works for the creator's saved target audience

Return as a JSON array of objects. Example:
[{{"text": "...", "trigger_type": "bold_claim", "sfx": "vine-boom", "edit_cue": "zoom-punch", "score": 8, "why": "..."}}]"""

    result = await ask_claude_json(
        prompt,
        system=_build_system_prompt(req),
        category="content_engine_hooks",
    )

    degraded = False
    if isinstance(result, dict) and "raw" in result:
        degraded = True
        warnings.append("Hook generator returned non-JSON output; using conservative fallback hooks.")
        hooks = [{
            "text": f"Tem uma coisa sobre {req.topic} que ninguém está a ver.",
            "trigger_type": "curiosity_gap",
            "sfx": "record-scratch",
            "edit_cue": "text-popup",
            "score": 5,
            "why": "Fallback hook kept intentionally simple because the AI output was malformed.",
        }]
    else:
        hooks = result if isinstance(result, list) else result.get("hooks", [result])

    duration_ms = int((time.monotonic() - start) * 1000)
    return HooksResponse(
        topic=req.topic,
        niche=req.niche,
        hooks=hooks[:req.count],
        duration_ms=duration_ms,
        degraded=degraded,
        warnings=warnings,
    )
