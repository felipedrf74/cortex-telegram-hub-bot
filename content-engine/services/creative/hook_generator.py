"""
Hook generator — creates scroll-stopping hooks using Claude + seed templates.

Hooks are the first 3 seconds of a video / first line of a post.
They must create an open loop (curiosity gap) that compels the viewer to stay.
"""

import time
import logging
from models.requests import HooksRequest, HooksResponse
from services.claude_client import ask_claude_json
from services.creator_profile import get_profile

logger = logging.getLogger("content-engine.hooks")

SYSTEM_PROMPT = f"""You are Felipe's viral hook specialist. You generate scroll-stopping hooks for his content.

{get_profile()}

HOOK RULES:
- Write in Portuguese (PT-BR), casual and direct — Felipe's voice
- Every hook must create a CURIOSITY GAP (open loop)
- Never start with "Olá pessoal" or "Neste vídeo" — those are anti-hooks
- Each hook should use a different viral trigger type
- Hooks should reflect Felipe's worldview — anti-state, pro-freedom, direct, no-BS
- Use data, controversy, or personal experience — never empty clickbait
- Return ONLY valid JSON, no markdown wrapping

VIRAL TRIGGER TYPES:
- curiosity_gap: Creates an open loop the viewer must close
- bold_claim: Makes a strong statement that demands attention
- data_shock: Uses a surprising number or statistic
- controversy: Challenges a popular belief or mainstream narrative
- identity: Makes the viewer think "that's me" (targets 18-35 men)
- urgency: Creates FOMO or time pressure
- story: Opens a personal narrative
- contrarian: Goes against what everyone else is saying
- challenge: Dares the viewer to rethink something"""


async def generate(req: HooksRequest) -> HooksResponse:
    start = time.monotonic()

    prompt = f"""Generate {req.count} unique hooks for the following:
- Topic: {req.topic}
- Niche: {req.niche}
- Format: {req.format}

These hooks are for Felipe's audience (Brazilian men, 18-35). They should sound like Felipe — direct, confident, sometimes provocative.

For each hook, provide:
1. "text": the hook text in PT-BR (max 15 words, conversational)
2. "trigger_type": which viral trigger it uses
3. "score": estimated effectiveness 1-10
4. "why": one sentence explaining why this hook works for Felipe's audience

Return as a JSON array of objects. Example:
[{{"text": "...", "trigger_type": "curiosity_gap", "score": 8, "why": "..."}}]"""

    result = await ask_claude_json(prompt, system=SYSTEM_PROMPT)

    hooks = result if isinstance(result, list) else result.get("hooks", [result])

    duration_ms = int((time.monotonic() - start) * 1000)
    return HooksResponse(
        topic=req.topic,
        niche=req.niche,
        hooks=hooks[:req.count],
        duration_ms=duration_ms,
    )
