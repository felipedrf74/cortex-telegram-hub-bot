"""
Script writer — generates full video scripts using Claude + research data.

This is the crown jewel of the creative suite.  It takes a topic, runs
the research pipeline to gather context, then asks Claude to write a
complete video script with timing marks, screen cues, and CTA.
"""

import json
import re
import time
import logging
from models.requests import ScriptRequest, ScriptResponse
from models.research import SourceReference
from services.claude_client import ask_claude, MODEL
from services.creator_profile import get_profile

logger = logging.getLogger("content-engine.script")

SHORT_FORM_WORD_TARGETS = {
    15: (30, 45),
    30: (65, 85),
    45: (95, 120),
    60: (125, 150),
}

SYSTEM_PROMPT = f"""You are the creator's AI scriptwriter.
Use the creator configuration below as the canonical source of identity, worldview, audience, language defaults, and production style.
Write natural, conversational scripts as if Felipe is talking to camera — never robotic, never generic.

{get_profile()}

AVAILABLE MARKERS (use throughout all scripts):
- [SFX:vine-boom] [SFX:metal-pipe] [SFX:fahhh] [SFX:bruh] [SFX:sad-violin] [SFX:among-us] [SFX:record-scratch] [SFX:ding] [SFX:boom]
- [EDIT:zoom-punch] [EDIT:hard-cut] [EDIT:speed-ramp] [EDIT:text-popup] [EDIT:deadpan-stare]
- [SHOW ON SCREEN: ...] for sources, screenshots, data
- [PLAY CLIP: timestamp-timestamp] for reaction content
- [CUT TO: ...] for visual variety

FORMAT-SPECIFIC STRUCTURES:

--- DEFAULT (YouTube essay/commentary) ---

=== HOOK (0:00-0:03) ===
[Pattern interrupt / bold statement / shocking visual]
[SFX:vine-boom] or [SFX:metal-pipe] on the punch
[Must create curiosity gap]

=== SETUP (0:03-0:30) ===
[Context: what, why should you care]
[SHOW ON SCREEN: source/stat]
[EDIT:text-popup] on key number or claim

=== BODY — Point 1 (0:30-2:00) ===
[Main argument with data]
[SHOW ON SCREEN: screenshot/source]
[SFX] on surprising reveals
[Transition hook to next point — open loop]

=== BODY — Point 2 (2:00-3:30) ===
[Supporting argument/counter-argument]
[SHOW ON SCREEN: tweet/article/study]
[EDIT:zoom-punch] on hot takes

=== BODY — Point 3 (3:30-5:00) ===
[Personal opinion / hot take / the twist]
[SFX:vine-boom] on the verdict
[This is where The Operator's personality shines]

=== PAYOFF (5:00-5:30) ===
[Close the loop from the hook]
[Emotional or thought-provoking conclusion]

=== CTA (5:30-6:00) ===
[Call to action — direct, not begging]

--- REACTION FORMAT ---
Use this when the FORMAT is "Reaction" or the topic involves reacting to content:

=== REACTION BEAT ===
[CONTENT plays 5-8s]
[PAUSE — face fills screen, 2-3s silence]
[SFX:vine-boom] or [SFX:metal-pipe]
"Mano."
[SFX:fahhh] or lean-back moment
[EDIT:deadpan-stare]
"Tá, vamos por partes..."
[Resume with point-by-point + meme overlays]
[SHOW ON SCREEN: counter-evidence or supporting data]
[EDIT:zoom-punch] on each key point
[Close with definitive take — commit, don't hedge]
[SFX:boom] on final verdict

Repeat REACTION BEAT for each segment of source content. Each beat should feel raw and unscripted.

--- BUILD LOG FORMAT ---
Use this when the topic involves AI builds, tech projects, automation, or coding:

=== HOOK (0:00-0:03) ===
Bold claim or demo of finished result
[SFX:vine-boom + EDIT:zoom-punch into screen]

=== PROBLEM (0:03-0:20) ===
Why this matters / what was broken
[EDIT:speed-ramp] through boring setup
[SHOW ON SCREEN: error messages, broken UI, terminal output]

=== BUILD (0:20-1:30) ===
Screen recording of actual building
Voiceover explaining decisions
[SFX] on key moments (successful runs, errors fixed)
[EDIT:text-popup] on tech stack choices
[SHOW ON SCREEN: code, terminal, architecture diagrams]

=== RESULT (1:30-2:00) ===
Live demo of working system
[SFX:vine-boom] on the reveal
CTA — "Link na descrição" or "Comenta se quer o tutorial"

RULES:
- Write in the exact language requested in the prompt
- Sound natural and conversational — like speaking, not reading
- Include [SHOW ON SCREEN: ...] markers at every data reference
- Include [SFX:...] markers at reaction moments, reveals, and punchlines
- Include [EDIT:...] markers for post-production cues
- Include [CUT TO: ...] for visual variety (retention)
- Include timing marks [0:00], [0:30], etc.
- **Bold** key phrases to emphasise in delivery
- For reaction scripts: [PLAY CLIP: timestamp-timestamp]
- Never use filler — every sentence must earn its place
- End with a thought that makes the viewer think or feel
- The Operator doesn't hedge — commit to the take

CRITICAL CONTENT ACCURACY RULES:

1. NEVER state a person's current legal/political/professional status from memory.
   ONLY use facts from the RESEARCH FINDINGS provided below.

2. For ANY claim about:
   - Who holds a political position → ONLY use from research, tag [VERIFIED: source]
   - Whether someone can/will run for election → ONLY use from research, tag [VERIFIED: source]
   - Court decisions, sentences, legal status → ONLY use from research, tag [VERIFIED: source]
   - Statistics, poll numbers, economic data → ONLY use from research, tag [VERIFIED: source]
   - Scientific/health claims → ONLY use from research, tag [VERIFIED: source]

3. If a claim cannot be found in the RESEARCH FINDINGS, DO NOT include it.
   Replace with: [NEEDS VERIFICATION: <claim>]

4. Separate FACTS from TAKES clearly:
   - FACT (needs source): "Bolsonaro está inelegível até 2030 [VERIFIED: TSE]"
   - TAKE (no source needed): "Isso muda completamente o jogo da direita"
   Mark opinions with [TAKE] so Felipe knows what's commentary vs. fact.

5. When discussing trending topics, ONLY reference information from the research findings.
   NEVER assume that because something was true in your training data, it is still true today.

6. At the END of every script, include a FONTES section:
   ---
   📋 FONTES VERIFICADAS:
   1. [Claim] — [Source from research] — [URL if available]
   ⚠️ ALERTAS: [Any claims marked NEEDS VERIFICATION]
   ---"""


def _normalize_language(language: str | None) -> str:
    normalized = (language or "pt-BR").strip().lower()
    if normalized.startswith("en"):
        return "en-US"
    if normalized == "pt-pt" or "european" in normalized:
        return "pt-PT"
    return "pt-BR"


def _normalize_render_mode(render_mode: str | None) -> str:
    normalized = (render_mode or "structured").strip().lower()
    return "chat" if normalized == "chat" else "structured"


def _normalize_script_style(script_style: str | None) -> str:
    normalized = (script_style or "detailed").strip().lower()
    return "bullets" if normalized in {"bullet", "bullets", "outline", "pontos"} else "detailed"


def _target_duration_seconds(req: ScriptRequest) -> int:
    if req.target_duration_seconds:
        return int(req.target_duration_seconds)
    format_name = (req.format or "").strip().lower()
    if format_name in {"short", "reel"} or req.max_duration_minutes <= 1:
        return max(15, min(int(req.max_duration_minutes * 60), 60))
    return max(60, int(req.max_duration_minutes * 60))


def _is_short_form(req: ScriptRequest) -> bool:
    format_name = (req.format or "").strip().lower()
    return format_name in {"short", "reel"} or _target_duration_seconds(req) <= 60


def _short_form_word_range(target_seconds: int) -> tuple[int, int]:
    return SHORT_FORM_WORD_TARGETS.get(target_seconds, SHORT_FORM_WORD_TARGETS[60])


def _format_timestamp(total_seconds: int) -> str:
    minutes, seconds = divmod(max(total_seconds, 0), 60)
    return f"{minutes}:{seconds:02d}"


def _estimated_duration(req: ScriptRequest) -> str:
    target_seconds = _target_duration_seconds(req)
    if _is_short_form(req):
        return _format_timestamp(target_seconds)
    youtube_presets = {
        480: "8:00",
        600: "10:00",
        900: "15:00",
    }
    return youtube_presets.get(target_seconds, _format_timestamp(target_seconds))


def _fallback_timestamps(req: ScriptRequest) -> list[str]:
    target_seconds = _target_duration_seconds(req)
    fractions = [0.0, 0.22, 0.48, 0.72, 0.92] if _is_short_form(req) else [0.0, 0.1, 0.35, 0.65, 0.9]
    return [_format_timestamp(round(target_seconds * fraction)) for fraction in fractions]


def _language_guidance(language: str) -> tuple[str, str]:
    if language == "en-US":
        return (
            "English (US/International)",
            "\n".join([
                "- Write every user-facing line in English.",
                "- Do NOT switch to Portuguese unless the user explicitly asked for Portuguese.",
                "- Keep headings, CTA, and metadata fully in English.",
            ]),
        )
    if language == "pt-PT":
        return (
            "Português Europeu",
            "\n".join([
                "- Escreve tudo em português europeu natural.",
                "- Não uses PT-BR, brasileirismos, ou headings em inglês.",
                "- Mantém títulos, CTA e metadata em português europeu.",
            ]),
        )
    return (
        "Português (PT-BR)",
        "\n".join([
            "- Escreve tudo em pt-BR natural e conversacional.",
            "- Não uses português europeu nem headings em inglês.",
            "- Mantém títulos, CTA e metadata em pt-BR.",
        ]),
    )


def _format_guidance(req: ScriptRequest) -> str:
    target_seconds = _target_duration_seconds(req)
    if _is_short_form(req):
        min_words, max_words = _short_form_word_range(target_seconds)
        return "\n".join([
            "- This is a SHORT-FORM script.",
            f"- Hit the {target_seconds}-second runtime cleanly; do not drift toward a 60-second generic short.",
            f"- Keep the spoken script around {min_words}-{max_words} words.",
            "- Use at most 4 spoken beats after the hook.",
            "- Timestamp the script so the final beat lands near the requested short duration.",
            "- Do NOT add a separate 'Visuals:' section or any preamble before the script.",
            "- Use inline [SHOW ON SCREEN: ...] markers inside the script instead of standalone visual notes.",
        ])
    if target_seconds >= 900:
        pacing = [
            "- This is a 15-minute YouTube script.",
            "- Use 9-12 timestamped beats so the arc can breathe without filler.",
            "- Bring the CTA in near the 14-minute mark and close close to 15:00.",
        ]
    elif target_seconds >= 600:
        pacing = [
            "- This is a 10-minute YouTube script.",
            "- Use 7-9 timestamped beats with clear transitions and one real midpoint turn.",
            "- Bring the CTA in near the 9-minute mark and close close to 10:00.",
        ]
    else:
        pacing = [
            "- This is an 8-minute YouTube script.",
            "- Use 6-8 timestamped beats and stay disciplined; every section must earn its minute.",
            "- Bring the CTA in near the 7-minute mark and close close to 8:00.",
        ]
    return "\n".join([
        *pacing,
        "- Stay tight and high-signal; do not pad with generic filler.",
        "- Timestamp the body so the ending lands close to the requested duration preset.",
        "- Use [SHOW ON SCREEN: ...] markers inline instead of adding standalone setup sections.",
    ])


def _render_mode_guidance(req: ScriptRequest, render_mode: str) -> str:
    if render_mode == "chat":
        rules = [
            "- Return a clean spoken script body that feels ready to paste directly into chat.",
            "- Do NOT use section headings, dividers, or labels such as `=== HOOK ===`, `HOOK:`, `SCRIPT:`, `CTA:`, `Visuals:`, or `FONTES VERIFICADAS:` in the script body.",
            "- Do NOT use production tags such as [SFX:], [EDIT:], [CUT TO:], [PLAY CLIP:], [TAKE], [VERIFIED:], or [NEEDS VERIFICATION:] in the chat body.",
            "- Do NOT narrate your research process, trend analysis, or source audit inside the spoken script.",
            "- Keep [SHOW ON SCREEN: ...] markers sparse and inline only when they genuinely help the delivery.",
            "- Keep the body conversational and punchy, not like a production template.",
            "- Put the standalone CTA in metadata; if the script itself ends with a CTA, make it sound natural rather than labeled.",
        ]
        if _is_short_form(req):
            min_words, max_words = _short_form_word_range(_target_duration_seconds(req))
            rules.append(f"- For short-form chat scripts, aim for roughly {min_words}-{max_words} spoken words.")
        return "\n".join(rules)

    return "\n".join([
        "- Use the richer creator-tool structure with research grounding and production-ready detail.",
        "- After the script body, include the FONTES VERIFICADAS appendix before the metadata block.",
    ])


def _script_style_guidance(req: ScriptRequest, script_style: str) -> str:
    if script_style == "bullets":
        return "\n".join([
            "- OUTPUT STYLE: BULLET POINTS.",
            "- Return a practical filming outline, not a full word-for-word script.",
            "- Include the hook, the sequence of beats, proof/source cues, suggested on-screen moments, and CTA.",
            "- Keep each bullet specific enough to film from; avoid generic slogans.",
        ])
    if _is_short_form(req):
        return "\n".join([
            "- OUTPUT STYLE: DETAILED SHORT SCRIPT.",
            "- Return the exact spoken text for the short-form video.",
            "- Make every beat distinct from long-form YouTube; shorts need a sharper first sentence, one clear tension, and a fast close.",
        ])
    return "\n".join([
        "- OUTPUT STYLE: DETAILED FULL SCRIPT.",
        "- Return the full spoken script text, not a summary.",
        "- Each timestamped section should include enough lines for the requested YouTube duration, with transitions and concrete examples.",
    ])


def _script_quality_guidance(req: ScriptRequest, script_style: str) -> str:
    format_name = (req.format or "").strip().lower()
    if _is_short_form(req):
        format_rule = (
            "- SHORTS/REELS must not be a compressed YouTube script. Use one tension, one turn, one payoff, and a fast close."
        )
    elif format_name in {"youtube", "longform", "long-form"}:
        format_rule = (
            "- YOUTUBE scripts must have a real argument arc: cold open, context, stakes, 3-5 developed beats, counterpoint, payoff."
        )
    else:
        format_rule = "- Match the requested format instead of recycling a generic YouTube outline."

    if script_style == "bullets":
        style_rule = "- BULLETS must be a production outline with creative beats, not the same full script with bullet marks."
    else:
        style_rule = "- DETAILED mode must deliver the spoken script, not a brief, not a summary, not a content plan."

    return "\n".join([
        "SCRIPT QUALITY BAR:",
        "- Do not use the generic pattern `X seems fast, but the real bottleneck is judgment` unless the topic explicitly calls for it.",
        "- Do not reuse the same hook/title/script skeleton across topics or formats.",
        "- Use at least 2 topic-specific examples or scenarios from the research or first-party context.",
        "- Make the opening feel written for this exact creator and this exact viewer, not for a generic AI content account.",
        "- If Voice DNA is provided, apply it to sentence rhythm, stance, vocabulary, and the kind of examples selected.",
        "- The final output should feel stronger than a default AI-generated script: concrete, opinionated, source-aware, and filmable.",
        format_rule,
        style_rule,
    ])


def _topic_context_block(req: ScriptRequest) -> str:
    context = getattr(req, "topic_context", None) or {}
    if not isinstance(context, dict):
        return ""

    lines: list[str] = []
    if context.get("hook_idea"):
        lines.append(f"- Hook idea already chosen upstream: {context['hook_idea']}")
    if context.get("why_now"):
        lines.append(f"- Why this matters now: {context['why_now']}")
    if context.get("angle_tag"):
        lines.append(f"- Chosen angle tag: {context['angle_tag']}")
    if context.get("source_job"):
        lines.append(f"- Source pipeline/job: {context['source_job']}")
    if context.get("topic_feedback_id") or context.get("pipeline_id") or context.get("idea_id"):
        lines.append(
            "- Treat this as first-party product context coming from an approved topic or pipeline decision, not just an ad-hoc prompt."
        )

    if not lines:
        return ""
    return "\nFIRST-PARTY TOPIC CONTEXT:\n" + "\n".join(lines)


def _fallback_titles(topic: str, language: str) -> list[str]:
    subject = _normalize_fallback_topic(topic)
    if language == "en-US":
        return [
            f"What nobody tells you about {subject}",
            f"How I would approach {subject} solo",
            f"{subject}: the operator breakdown",
        ]
    if language == "pt-PT":
        return [
            f"O que ninguém te diz sobre {subject}",
            f"Como eu abordaria {subject} sozinho",
            f"{subject}: a leitura do Operator",
        ]
    return [
        f"O que ninguém te conta sobre {subject}",
        f"Como eu abordaria {subject} sozinho",
        f"{subject}: o breakdown do Operator",
    ]


def _fallback_caption(topic: str, language: str) -> str:
    subject = _normalize_fallback_topic(topic)
    if language == "en-US":
        return f"If you're working on {subject}, speed only helps when the product logic stays clear. Save this before your next build sprint."
    if language == "pt-PT":
        return f"Se estás a trabalhar em {subject}, a velocidade só ajuda quando a lógica do produto está clara. Guarda isto antes do próximo sprint."
    return f"Se você está trabalhando em {subject}, velocidade só ajuda quando a lógica do produto está clara. Salva isso antes do próximo sprint."


def _fallback_cta(language: str) -> str:
    if language == "en-US":
        return "Save this and send it to the builder who's trying to do everything at once."
    if language == "pt-PT":
        return "Guarda isto e envia a quem está a tentar construir tudo ao mesmo tempo."
    return "Salva isso e manda para quem está tentando construir tudo ao mesmo tempo."


def _normalize_fallback_topic(topic: str) -> str:
    subject = re.sub(r"\s+", " ", (topic or "").strip())
    patterns = [
        r"^(?:create|write|generate)\s+(?:a\s+)?(?:script|video script|youtube script|short script|reel script)\s+(?:about|on)\s+",
        r"^(?:cria|crie|escreve|escreva|gera|gere)\s+(?:um\s+)?(?:roteiro|script)\s+(?:sobre|para)\s+",
        r"^(?:topic|tema)\s*:\s*",
    ]
    for pattern in patterns:
        subject = re.sub(pattern, "", subject, flags=re.IGNORECASE)
    return subject.strip(" .!?") or "this topic"


def _fallback_hashtags(topic: str) -> list[str]:
    normalized = _normalize_fallback_topic(topic).lower()
    topic_tokens = re.findall(r"[a-zA-Z0-9]+", normalized)
    derived = [f"#{token}" for token in topic_tokens[:2] if len(token) > 3]
    base = ["#theoperator", "#buildinpublic", "#product", "#systems"]
    merged: list[str] = []
    for tag in derived + base:
        if tag not in merged:
            merged.append(tag)
    return merged[:5]


def _is_usable_key_point(point: str) -> bool:
    lower = point.lower()
    blocked_signals = [
        "source context:",
        "set serpapi_api_key",
        "set youtube_api_key",
        "set newsapi_api_key",
        "mock ",
        "add felipe's perspective",
        "turn the strongest verified point",
        "validate the strongest claims",
    ]
    return bool(point.strip()) and not any(signal in lower for signal in blocked_signals)


def _pick_key_points(briefs: list) -> list[str]:
    points: list[str] = []
    for brief in briefs[:3]:
        for point in getattr(brief, "key_points", [])[:3]:
            cleaned = str(point).strip()
            if _is_usable_key_point(cleaned) and cleaned not in points:
                points.append(cleaned)
    return points[:3]


def _build_degraded_script_response(
    req: ScriptRequest,
    briefs: list,
    sources_used: list[SourceReference],
    est_duration: str,
    start: float,
    language: str,
    warnings: list[str],
    script_style: str,
    brand_voice: str | None,
) -> ScriptResponse:
    topic = req.topic.strip()
    subject = _normalize_fallback_topic(topic)
    render_mode = _normalize_render_mode(getattr(req, "render_mode", None))
    normalized_style = _normalize_script_style(script_style)
    key_points = _pick_key_points(briefs)
    cta = _fallback_cta(language)
    cta_line = cta if render_mode == "chat" else f"CTA: {cta}"
    timestamps = _fallback_timestamps(req)
    short_form = _is_short_form(req)
    voice_seed = " ".join((brand_voice or "").strip().split())[:260]
    voice_line = ""
    if voice_seed:
        voice_line = {
            "en-US": f"Voice DNA to preserve: {voice_seed}",
            "pt-PT": f"Voice DNA a preservar: {voice_seed}",
        }.get(language, f"Voice DNA a preservar: {voice_seed}")

    if language == "en-US":
        hook = f"If you're trying to {subject.lower()}, the trap is thinking speed replaces judgment."
        beats = [
            key_points[0] if len(key_points) > 0 else "Name the one painful problem this solves for a real person.",
            key_points[1] if len(key_points) > 1 else "Show the constraint, the tradeoff, and the decision that changed the build.",
            key_points[2] if len(key_points) > 2 else "Prove demand with the smallest loop people will repeat.",
            key_points[3] if len(key_points) > 3 else "Make the takeaway concrete enough to use today.",
        ]
        if normalized_style == "bullets":
            script = "\n".join([
                f"- Hook: {hook}",
                f"- Tension: {subject} looks like a speed problem, but it is really a judgment problem.",
                f"- Beat 1: {beats[0]}",
                f"- Beat 2: {beats[1]}",
                f"- Beat 3: {beats[2]}",
                f"- Proof moment: {beats[3]}",
                f"- On screen: Speed without clarity = noise",
                f"- CTA: {cta}",
                f"- {voice_line}" if voice_line else "",
            ]).strip()
        elif short_form or render_mode == "chat":
            script = "\n\n".join([
                f"**{subject}** sounds fast because AI is helping. But the real bottleneck is still judgment.",
                f"Here is the filter: {beats[0]} Then make the tradeoff visible: {beats[1]}",
                f"Close with proof, not hype: {beats[2]} {beats[3]}",
                cta,
            ])
        else:
            script = "\n".join([
                f"[{timestamps[0]}] **{subject}** sounds like a speed story, but it is actually a judgment story. [SHOW ON SCREEN: \"Speed without clarity = noise\"]",
                f"[{timestamps[1]}] First: frame the real constraint. {beats[0]} This is where most generic scripts skip the useful part.",
                f"[{timestamps[2]}] Second: show the decision under pressure. {beats[1]} Give the audience the fork in the road, not just the conclusion.",
                f"[{timestamps[3]}] Third: turn it into a repeatable operating rule. {beats[2]} {beats[3]}",
                f"[{timestamps[-1]}] {cta_line}",
            ])
    elif language == "pt-PT":
        hook = f"Se estás a tentar {subject.lower()}, o erro é achar que velocidade substitui critério."
        beats = [
            key_points[0] if len(key_points) > 0 else "Define o problema doloroso que isto resolve para uma pessoa concreta.",
            key_points[1] if len(key_points) > 1 else "Mostra a restrição, a troca e a decisão que mudou o caminho.",
            key_points[2] if len(key_points) > 2 else "Prova procura com o ciclo mínimo que alguém repetiria.",
            key_points[3] if len(key_points) > 3 else "Fecha com uma regra prática que a pessoa consegue usar hoje.",
        ]
        if normalized_style == "bullets":
            script = "\n".join([
                f"- Hook: {hook}",
                f"- Tensão: {subject} parece um problema de velocidade, mas é um problema de critério.",
                f"- Beat 1: {beats[0]}",
                f"- Beat 2: {beats[1]}",
                f"- Beat 3: {beats[2]}",
                f"- Momento de prova: {beats[3]}",
                f"- No ecrã: Velocidade sem clareza = ruído",
                f"- CTA: {cta}",
                f"- {voice_line}" if voice_line else "",
            ]).strip()
        elif short_form or render_mode == "chat":
            script = "\n\n".join([
                f"**{subject}** parece rápido com IA. Mas o verdadeiro bloqueio continua a ser critério.",
                f"O filtro é este: {beats[0]} Depois mostra a troca real: {beats[1]}",
                f"Fecha com prova, não com hype: {beats[2]} {beats[3]}",
                cta,
            ])
        else:
            script = "\n".join([
                f"[{timestamps[0]}] **{subject}** parece uma história de velocidade, mas é uma história de critério. [SHOW ON SCREEN: \"Velocidade sem clareza = ruído\"]",
                f"[{timestamps[1]}] Primeiro: enquadra a restrição real. {beats[0]} É aqui que os roteiros genéricos saltam a parte útil.",
                f"[{timestamps[2]}] Segundo: mostra a decisão sob pressão. {beats[1]} Dá ao público a bifurcação, não só a conclusão.",
                f"[{timestamps[3]}] Terceiro: transforma isto numa regra operacional. {beats[2]} {beats[3]}",
                f"[{timestamps[-1]}] {cta_line}",
            ])
    else:
        hook = f"Se você está tentando {subject.lower()}, o erro é achar que velocidade substitui critério."
        beats = [
            key_points[0] if len(key_points) > 0 else "Defina o problema doloroso que isso resolve para uma pessoa real.",
            key_points[1] if len(key_points) > 1 else "Mostre a restrição, a troca e a decisão que mudou o caminho.",
            key_points[2] if len(key_points) > 2 else "Prove demanda com o menor loop que alguém repetiria.",
            key_points[3] if len(key_points) > 3 else "Feche com uma regra prática que a pessoa consegue usar hoje.",
        ]
        if normalized_style == "bullets":
            script = "\n".join([
                f"- Hook: {hook}",
                f"- Tensão: {subject} parece um problema de velocidade, mas é um problema de critério.",
                f"- Beat 1: {beats[0]}",
                f"- Beat 2: {beats[1]}",
                f"- Beat 3: {beats[2]}",
                f"- Momento de prova: {beats[3]}",
                f"- Na tela: Velocidade sem clareza = ruído",
                f"- CTA: {cta}",
                f"- {voice_line}" if voice_line else "",
            ]).strip()
        elif short_form or render_mode == "chat":
            script = "\n\n".join([
                f"**{subject}** parece rápido com IA. Mas o gargalo real continua sendo critério.",
                f"O filtro é esse: {beats[0]} Depois mostre a troca real: {beats[1]}",
                f"Feche com prova, não com hype: {beats[2]} {beats[3]}",
                cta,
            ])
        else:
            script = "\n".join([
                f"[{timestamps[0]}] **{subject}** parece uma história de velocidade, mas é uma história de critério. [SHOW ON SCREEN: \"Velocidade sem clareza = ruído\"]",
                f"[{timestamps[1]}] Primeiro: enquadre a restrição real. {beats[0]} É aqui que roteiros genéricos pulam a parte útil.",
                f"[{timestamps[2]}] Segundo: mostre a decisão sob pressão. {beats[1]} Dê ao público a bifurcação, não só a conclusão.",
                f"[{timestamps[3]}] Terceiro: transforme isso numa regra operacional. {beats[2]} {beats[3]}",
                f"[{timestamps[-1]}] {cta_line}",
            ])

    if voice_line and normalized_style != "bullets":
        script = f"{script}\n\n{voice_line}"
        warnings.append("Voice DNA memory was applied to the degraded fallback.")
    warnings.append("AI generation was unavailable; returned a templated degraded script grounded in the available research.")
    duration_ms = int((time.monotonic() - start) * 1000)
    return ScriptResponse(
        topic=topic,
        script=script,
        hook=hook,
        title_options=_fallback_titles(topic, language),
        sources_used=sources_used[:5],
        estimated_duration=est_duration,
        duration_ms=duration_ms,
        hashtags=_fallback_hashtags(topic),
        caption=_fallback_caption(topic, language),
        cta=cta,
        degraded=True,
        warnings=warnings,
    )


def _fallback_parse(raw: str) -> tuple[str, str, list[str], list[str], str, str]:
    """Legacy line-by-line parser for backward compatibility."""
    lines = raw.strip().split("\n")
    hook = ""
    title_options: list[str] = []
    hashtags: list[str] = []
    caption = ""
    cta = ""
    script_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("HOOK:"):
            hook = stripped[5:].strip()
        elif stripped.startswith("TITLE1:") or stripped.startswith("TITLE2:") or stripped.startswith("TITLE3:"):
            title_options.append(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("HASHTAGS:"):
            raw_tags = stripped[9:].strip()
            hashtags = [t.strip() for t in raw_tags.split() if t.startswith("#")]
        elif stripped.startswith("CAPTION:"):
            caption = stripped[8:].strip()
        elif stripped.startswith("CTA:"):
            cta = stripped[4:].strip()
        else:
            script_lines.append(line)

    return "\n".join(script_lines).strip(), hook, title_options, hashtags, caption, cta


def _clean_chat_script(script: str) -> str:
    cleaned_lines: list[str] = []
    for raw_line in script.replace("\r\n", "\n").split("\n"):
        line = raw_line.strip()
        if not line:
            if cleaned_lines and cleaned_lines[-1] != "":
                cleaned_lines.append("")
            continue

        if re.match(r"^(?:📋\s*)?FONTES VERIFICADAS\s*:?", line, flags=re.IGNORECASE):
            break
        if re.match(r"^ALERTAS\s*:?", line, flags=re.IGNORECASE):
            break
        if re.match(r"^=+\s*.*\s*=+$", line):
            continue
        if re.match(r"^(?:SHOW ON SCREEN|ON SCREEN|VISUAL|B-ROLL)\s*:", line, flags=re.IGNORECASE):
            continue
        if re.match(r"^(?:HOOK|GANCHO|SETUP|PAYOFF|SCRIPT|ROTEIRO|CTA|CAPTION|HASHTAGS?|TITLES?|TITLE OPTIONS|T[ÍI]TULOS?)\s*:?\s*$", line, flags=re.IGNORECASE):
            continue
        if re.match(r"^(?:CTA|CAPTION|HASHTAGS?|TITLES?|TITLE OPTIONS|T[ÍI]TULOS?)\s*:", line, flags=re.IGNORECASE):
            continue

        line = re.sub(r"^(?:HOOK|GANCHO|SCRIPT|ROTEIRO)\s*:\s*", "", line, flags=re.IGNORECASE).strip()
        line = re.sub(r"\[(?:SHOW ON SCREEN|ON SCREEN|VISUAL|B-ROLL):[^\]]+\]", "", line, flags=re.IGNORECASE)
        line = re.sub(r"\[(?:SFX|EDIT|CUT TO|PLAY CLIP):[^\]]+\]", "", line, flags=re.IGNORECASE)
        line = re.sub(r"\[(?:PAUSE|BEAT)\]", "", line, flags=re.IGNORECASE)
        line = re.sub(r"\[(?:TAKE)\]", "", line, flags=re.IGNORECASE)
        line = re.sub(r"\[(?:VERIFIED|NEEDS VERIFICATION):[^\]]+\]", "", line, flags=re.IGNORECASE)
        line = re.sub(r"\s{2,}", " ", line).strip()
        line = re.sub(r"\s+([,.;!?])", r"\1", line)
        line = re.sub(r"\.{2,}", ".", line)
        line = re.sub(r"([!?])\.", r"\1", line)
        if line:
            cleaned_lines.append(line)

    cleaned = "\n".join(cleaned_lines).strip()
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return _strip_inline_markdown_emphasis(cleaned or script.strip())


def _strip_inline_markdown_emphasis(script: str) -> str:
    cleaned = re.sub(r"\*\*([^*\n][^*]*?)\*\*", r"\1", script)
    cleaned = re.sub(r"__([^_\n][^_]*?)__", r"\1", cleaned)
    return cleaned


def _clean_script_dividers(script: str) -> str:
    cleaned_lines: list[str] = []
    for raw_line in script.replace("\r\n", "\n").split("\n"):
        line = raw_line.strip()
        if re.match(r"^={2,}\s*[^=]+\s*={2,}$", line):
            continue
        if re.match(r"^(HOOK|SCRIPT|ROTEIRO|FULL SCRIPT|ROTEIRO COMPLETO)\s*:?$", line, re.IGNORECASE):
            continue
        cleaned_lines.append(raw_line)
    cleaned = "\n".join(cleaned_lines).strip()
    return _strip_inline_markdown_emphasis(cleaned or script.strip())


async def generate(req: ScriptRequest, orchestrator) -> ScriptResponse:
    start = time.monotonic()
    warnings: list[str] = []
    degraded = False
    normalized_mode = (getattr(req, "mode", "standard") or "standard").strip().lower()
    normalized_language = _normalize_language(req.language)
    normalized_render_mode = _normalize_render_mode(getattr(req, "render_mode", None))
    normalized_script_style = _normalize_script_style(getattr(req, "script_style", None))
    language_label, language_rules = _language_guidance(normalized_language)
    format_rules = _format_guidance(req)
    render_mode_rules = _render_mode_guidance(req, normalized_render_mode)
    script_style_rules = _script_style_guidance(req, normalized_script_style)
    script_quality_rules = _script_quality_guidance(req, normalized_script_style)
    topic_context_block = _topic_context_block(req)
    brand_voice_block = ""
    if req.brand_voice and req.brand_voice.strip():
        brand_voice_block = (
            "\nBRAND VOICE MEMORY (adapt, don't copy verbatim):\n"
            f"{req.brand_voice.strip()[:4000]}\n"
        )

    # Step 1: Research the topic
    if normalized_mode == "quick":
        research = await orchestrator.quick_search(req.topic, max_results=3)
        warnings.append("Quick mode used shallow research without deep synthesis.")
    else:
        research = await orchestrator.deep_search(req.topic, max_results=5)
    briefs = research.briefs
    if getattr(research, "degraded", False):
        degraded = True
        warnings.extend(getattr(research, "warnings", []))

    # Build research context for Claude — include full details + source URLs for fact verification
    research_context = ""
    sources_used: list[SourceReference] = []
    for i, b in enumerate(briefs[:5], 1):
        research_context += f"\n[RESEARCH {i}] {b.title}\n"
        research_context += f"  Summary: {b.why_now[:300]}\n"
        if hasattr(b, 'key_points') and b.key_points:
            for kp in b.key_points[:3]:
                research_context += f"  • {kp}\n"
        for src in b.sources[:3]:
            research_context += f"  SOURCE: {src.title} — {src.url}\n"
            sources_used.append(src)

    # Estimated duration mapping
    est_duration = _estimated_duration(req)

    # Build intelligence context from bus signals
    intelligence_block = ""
    if req.context_signals:
        sections = []
        for sig in req.context_signals:
            sig_type = sig.get("type", "")
            payload = sig.get("payload", {})

            if sig_type == "hook_effectiveness":
                rec = payload.get("recommendation", "")
                if rec:
                    sections.append(f"HOOK INSIGHT: {rec}")

            elif sig_type == "voice_pattern":
                desc = payload.get("description", "")
                if desc:
                    sections.append(f"VOICE PATTERN: {desc}")

            elif sig_type == "voice_phrase_trend":
                phrase = payload.get("phrase", "")
                ctx = payload.get("context", "")
                if phrase:
                    sections.append(f"FELIPE'S PHRASE: \"{phrase}\" — use when: {ctx}")

            elif sig_type == "channel_dna" and payload.get("category") in ("hook_style", "storytelling", "content_structure"):
                patterns = payload.get("patterns", [])
                if patterns:
                    channel = payload.get("channel_name", "")
                    sections.append(f"REFERENCE ({channel} — {payload['category']}): {', '.join(patterns[:3])}")

            elif sig_type == "book_knowledge":
                thesis = payload.get("core_thesis", "")
                title = payload.get("title", "")
                frameworks = payload.get("key_frameworks", [])
                if thesis:
                    fw_names = [f.get("name", "") for f in frameworks[:2]]
                    sections.append(f"BOOK ({title}): {thesis[:150]}. Frameworks: {', '.join(fw_names)}")

            elif sig_type == "keyword_rank_change":
                kw = payload.get("keyword", "")
                if kw:
                    sections.append(f"SEO TARGET: Work in the keyword \"{kw}\" naturally")

            elif sig_type == "retention_pattern":
                rec = payload.get("recommendation", "")
                if rec:
                    sections.append(f"RETENTION: {rec}")

            elif sig_type == "pillar_performance":
                rankings = payload.get("rankings", [])
                if rankings:
                    top = rankings[0]
                    sections.append(f"TOP PILLAR: {top.get('pillar', '')} ({top.get('avg_views', 0)} avg views, trend: {top.get('trend', 'stable')})")

        if sections:
            intelligence_block = "\n\nINTELLIGENCE FROM CONTENT AGENTS:\n" + "\n".join(f"• {s}" for s in sections[:15])

    prompt = f"""Write a complete video script about: {req.topic}

NICHE: {req.niche}
FORMAT: {req.format}
TARGET DURATION: {est_duration}
LANGUAGE: {language_label}
RENDER MODE: {normalized_render_mode.upper()}
OUTPUT STYLE: {normalized_script_style.upper()}

LANGUAGE RULES:
{language_rules}

FORMAT RULES:
{format_rules}

RENDER MODE RULES:
{render_mode_rules}

OUTPUT STYLE RULES:
{script_style_rules}

{script_quality_rules}{topic_context_block}{brand_voice_block}

VERIFIED RESEARCH FINDINGS (USE ONLY THESE AS FACTUAL BASIS):
{research_context}{intelligence_block}

ACCURACY INSTRUCTIONS:
- ONLY use facts that appear in the RESEARCH FINDINGS above.
- Tag factual claims with [VERIFIED: source name] inline.
- Tag your opinions/commentary with [TAKE] so Felipe knows what's fact vs. opinion.
- If you want to make a claim NOT found in research, mark it [NEEDS VERIFICATION: claim].
- DO NOT invent statistics, poll numbers, dates, legal outcomes, or people's current status.
- If FIRST-PARTY TOPIC CONTEXT is present, treat it as the primary editorial direction and use research to sharpen it rather than replacing it with some unrelated pillar.
{"- At the end, include a FONTES VERIFICADAS section listing sources used." if normalized_render_mode != "chat" else "- Keep source grounding invisible in the spoken body unless a fact truly needs an inline source cue."}

Also provide:
1. A killer hook (first line of the script)
2. Three title options for this video
3. 5-8 relevant hashtags for Instagram/YouTube
4. A short social media caption (1-2 sentences, with emoji, for Instagram/YouTube description)
5. The CTA (call to action) as a standalone line

{"Write the complete script now. Return only the clean spoken script body before the metadata separator. Do NOT include a FONTES VERIFICADAS appendix, section headings, or labeled metadata in the script body." if normalized_render_mode == "chat" else ("Write the bullet-point filming outline now. Start with the hook, then the core beats, proof/source cues, on-screen ideas, and CTA.\n\nAfter the outline, add a FONTES VERIFICADAS section listing sources." if normalized_script_style == "bullets" else "Write the complete script now. Start with the spoken hook, follow the structure, end with CTA. Do NOT use decorative dividers or labels like `=== HOOK ===`, `=== SCRIPT ===`, `HOOK:`, or `SCRIPT:`; the app already renders those sections.\n\nAfter the script, add a FONTES VERIFICADAS section listing sources.")}

Then, on a NEW LINE, write exactly `---METADATA---` followed by a JSON object with these fields:
```json
{{
  "hook": "the hook text (first line of the script)",
  "titles": ["title option 1", "title option 2", "title option 3"],
  "hashtags": ["#tag1", "#tag2", "#tag3"],
  "caption": "social media caption text",
  "cta": "call to action text"
}}
```
The JSON must be valid and on a single block after `---METADATA---`. No other text after the JSON."""

    # Use Sonnet for script quality. If the AI proxy/provider layer is
    # unavailable, return a clearly degraded script grounded in the
    # research already collected instead of exploding into a 500.
    try:
        raw = await ask_claude(prompt, system=SYSTEM_PROMPT, model=MODEL, max_tokens=8192, category="content_engine_script")
    except Exception as exc:
        logger.warning("AI generation unavailable for script_writer.generate: %s", exc)
        return _build_degraded_script_response(
            req=req,
            briefs=briefs,
            sources_used=sources_used,
            est_duration=est_duration,
            start=start,
            language=normalized_language,
            warnings=warnings,
            script_style=normalized_script_style,
            brand_voice=req.brand_voice,
        )

    # Parse metadata from JSON block after ---METADATA--- separator
    hook = ""
    title_options: list[str] = []
    hashtags: list[str] = []
    caption = ""
    cta = ""

    SEPARATOR = "---METADATA---"
    if SEPARATOR in raw:
        parts = raw.split(SEPARATOR, 1)
        script_text = parts[0].strip()
        metadata_raw = parts[1].strip()
        # Strip markdown code fences if Claude wrapped the JSON
        if metadata_raw.startswith("```"):
            fence_lines = metadata_raw.split("\n")
            metadata_raw = "\n".join(
                fence_lines[1:-1] if fence_lines[-1].strip() == "```" else fence_lines[1:]
            )
        try:
            meta = json.loads(metadata_raw)
            hook = meta.get("hook", "")
            title_options = meta.get("titles", [])
            hashtags = meta.get("hashtags", [])
            caption = meta.get("caption", "")
            cta = meta.get("cta", "")
        except json.JSONDecodeError:
            logger.warning("Failed to parse script metadata JSON, falling back to line parsing")
            degraded = True
            warnings.append("Script metadata was malformed; fallback parsing was used.")
            script_text, hook, title_options, hashtags, caption, cta = _fallback_parse(raw)
    else:
        # Fallback: legacy line-by-line parsing for backward compatibility
        logger.info("No ---METADATA--- separator found, using legacy line parser")
        degraded = True
        warnings.append("Script response missed the metadata separator; fallback parsing was used.")
        script_text, hook, title_options, hashtags, caption, cta = _fallback_parse(raw)

    if normalized_render_mode == "chat":
        script_text = _clean_chat_script(script_text)
    else:
        script_text = _clean_script_dividers(script_text)

    # Final fallbacks if parsing didn't find hook/titles
    if not hook and briefs:
        hook = briefs[0].hook
    if not title_options:
        title_options = [req.topic, f"A VERDADE sobre {req.topic}", f"REAGINDO a {req.topic}"]

    duration_ms = int((time.monotonic() - start) * 1000)
    return ScriptResponse(
        topic=req.topic,
        script=script_text,
        hook=hook,
        title_options=title_options,
        sources_used=sources_used[:5],
        estimated_duration=est_duration,
        duration_ms=duration_ms,
        hashtags=hashtags,
        caption=caption,
        cta=cta,
        degraded=degraded,
        warnings=warnings,
    )
