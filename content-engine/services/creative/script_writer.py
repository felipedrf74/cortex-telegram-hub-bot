"""
Script writer — generates full video scripts using Claude + research data.

This is the crown jewel of the creative suite.  It takes a topic, runs
the research pipeline to gather context, then asks Claude to write a
complete video script with timing marks, screen cues, and CTA.
"""

import time
import logging
from models.requests import ScriptRequest, ScriptResponse
from models.research import SourceReference
from services.claude_client import ask_claude, MODEL
from services.creator_profile import get_profile

logger = logging.getLogger("content-engine.script")

SYSTEM_PROMPT = f"""You are The Operator's AI scriptwriter. Felipe Dominguez — "The Operator" — builds AI bots, trains for triathlon, eats only steak, and has opinions about everything.
You write natural, conversational scripts as if Felipe is talking to camera — never robotic.

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
- Write in Portuguese (PT-BR)
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


async def generate(req: ScriptRequest, orchestrator) -> ScriptResponse:
    start = time.monotonic()

    # Step 1: Research the topic
    research = await orchestrator.deep_search(req.topic, max_results=5)
    briefs = research.briefs

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
    duration_map = {
        "Short": "0:30-1:00",
        "Reel": "0:30-1:00",
        "YouTube": f"{req.max_duration_minutes-2}:00-{req.max_duration_minutes}:00",
    }
    est_duration = duration_map.get(req.format, f"{req.max_duration_minutes}:00")

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
LANGUAGE: {req.language}

VERIFIED RESEARCH FINDINGS (USE ONLY THESE AS FACTUAL BASIS):
{research_context}{intelligence_block}

ACCURACY INSTRUCTIONS:
- ONLY use facts that appear in the RESEARCH FINDINGS above.
- Tag factual claims with [VERIFIED: source name] inline.
- Tag your opinions/commentary with [TAKE] so Felipe knows what's fact vs. opinion.
- If you want to make a claim NOT found in research, mark it [NEEDS VERIFICATION: claim].
- DO NOT invent statistics, poll numbers, dates, legal outcomes, or people's current status.
- At the end, include a FONTES VERIFICADAS section listing sources used.

Also provide:
1. A killer hook (first line of the script)
2. Three title options for this video
3. 5-8 relevant hashtags for Instagram/YouTube
4. A short social media caption (1-2 sentences, with emoji, for Instagram/YouTube description)
5. The CTA (call to action) as a standalone line

Write the complete script now. Start with the hook, follow the structure, end with CTA.
After the script, on separate lines write:
HOOK: [the hook text]
TITLE1: [first title option]
TITLE2: [second title option]
TITLE3: [third title option]
HASHTAGS: [#tag1 #tag2 #tag3 ...]
CAPTION: [social media caption text]
CTA: [call to action text]

Then include:
---
📋 FONTES VERIFICADAS:
[list each source used with URL]
⚠️ ALERTAS: [any claims marked NEEDS VERIFICATION]
---"""

    # Use Sonnet for script quality
    raw = await ask_claude(prompt, system=SYSTEM_PROMPT, model=MODEL, max_tokens=8192)

    # Parse hook, titles, hashtags, caption, CTA from the end of the response
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

    script_text = "\n".join(script_lines).strip()

    # Fallback if parsing didn't find hook/titles
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
    )
