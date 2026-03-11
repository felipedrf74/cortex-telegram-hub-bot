"""
Hook generator — creates scroll-stopping hooks using Claude + seed templates.

Hooks are the first 3 seconds of a video / first line of a post.
They must create an open loop (curiosity gap) that compels the viewer to stay.
"""

import time
import logging
from models.requests import HooksRequest, HooksResponse
from services.claude_client import ask_claude_json

logger = logging.getLogger("content-engine.hooks")

# Seed templates per niche — these are proven patterns
HOOK_TEMPLATES = {
    "fitness": [
        "Eu treinei {topic} por 30 dias e isto aconteceu...",
        "90% das pessoas fazem {topic} errado. Tu és uma delas?",
        "O estudo que NINGUÉM te mostra sobre {topic}...",
        "Pare de fazer isto no treino. Aqui está o porquê.",
        "O que acontece quando um carnívoro experimenta {topic}...",
    ],
    "commentary": [
        "Vocês viram o que aconteceu? Eu não acredito...",
        "A verdade que ninguém tem coragem de falar sobre {topic}...",
        "Eu vou ser cancelado por isto, mas alguém precisa dizer...",
        "Isto é o que acontece quando {topic}...",
        "{topic} acabou de DESTRUIR a própria carreira com isto...",
    ],
    "general": [
        "Você não vai acreditar no que está acontecendo com {topic}...",
        "Ninguém está falando sobre isto: {topic}",
        "A verdade sobre {topic} que vão tentar esconder de você...",
        "Isto muda TUDO sobre {topic}...",
        "Se tu não sabes disto sobre {topic}, estás a perder...",
    ],
}

SYSTEM_PROMPT = """You are a viral content hook specialist for Portuguese-language (PT-BR) content.
You generate scroll-stopping hooks — the first 3 seconds of a video or first line of a caption.

RULES:
- Write in Portuguese (PT-BR), casual and direct
- Every hook must create a CURIOSITY GAP (open loop)
- Never start with "Olá pessoal" or "Neste vídeo" — those are anti-hooks
- Each hook should use a different viral trigger type
- Return ONLY valid JSON, no markdown wrapping

VIRAL TRIGGER TYPES:
- curiosity_gap: Creates an open loop the viewer must close
- bold_claim: Makes a strong statement that demands attention
- data_shock: Uses a surprising number or statistic
- controversy: Challenges a popular belief
- identity: Makes the viewer think "that's me"
- urgency: Creates FOMO or time pressure
- story: Opens a personal narrative"""


async def generate(req: HooksRequest) -> HooksResponse:
    start = time.monotonic()

    prompt = f"""Generate {req.count} unique hooks for the following:
- Topic: {req.topic}
- Niche: {req.niche}
- Format: {req.format}

For each hook, provide:
1. "text": the hook text in PT-BR (max 15 words)
2. "trigger_type": which viral trigger it uses
3. "score": estimated effectiveness 1-10
4. "why": one sentence explaining why this hook works

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
