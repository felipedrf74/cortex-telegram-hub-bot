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

SYSTEM_PROMPT = f"""You are Felipe's AI scriptwriter for Portuguese-language YouTube content.
You write natural, conversational scripts as if Felipe is talking to camera — never robotic.

{get_profile()}

SCRIPT STRUCTURE (enforce for every script):

=== HOOK (0:00-0:03) ===
[Pattern interrupt / bold statement / shocking visual]
[Must create curiosity gap]

=== SETUP (0:03-0:30) ===
[Context: what, why should you care]
[SHOW ON SCREEN: source/stat]

=== BODY — Point 1 (0:30-2:00) ===
[Main argument with data]
[SHOW ON SCREEN: screenshot/source]
[Transition hook to next point — open loop]

=== BODY — Point 2 (2:00-3:30) ===
[Supporting argument/counter-argument]
[SHOW ON SCREEN: tweet/article/study]

=== BODY — Point 3 (3:30-5:00) ===
[Personal opinion / hot take / the twist]
[This is where Felipe's personality shines]

=== PAYOFF (5:00-5:30) ===
[Close the loop from the hook]
[Emotional or thought-provoking conclusion]

=== CTA (5:30-6:00) ===
[Niche-appropriate call to action]

RULES:
- Write in Portuguese (PT-BR)
- Sound natural and conversational — like speaking, not reading
- Include [SHOW ON SCREEN: ...] markers at every data reference
- Include [CUT TO: ...] for visual variety (retention)
- Include timing marks [0:00], [0:30], etc.
- **Bold** key phrases to emphasise in delivery
- For reaction scripts: [PLAY CLIP: timestamp-timestamp]
- Never use filler — every sentence must earn its place
- End with a thought that makes the viewer think or feel"""


async def generate(req: ScriptRequest, orchestrator) -> ScriptResponse:
    start = time.monotonic()

    # Step 1: Research the topic
    research = await orchestrator.deep_search(req.topic, max_results=5)
    briefs = research.briefs

    # Build research context for Claude
    research_context = ""
    sources_used: list[SourceReference] = []
    for b in briefs[:5]:
        research_context += f"- {b.title}: {b.why_now[:150]}\n"
        sources_used.extend(b.sources)

    # Estimated duration mapping
    duration_map = {
        "Short": "0:30-1:00",
        "Reel": "0:30-1:00",
        "YouTube": f"{req.max_duration_minutes-2}:00-{req.max_duration_minutes}:00",
    }
    est_duration = duration_map.get(req.format, f"{req.max_duration_minutes}:00")

    prompt = f"""Write a complete video script about: {req.topic}

NICHE: {req.niche}
FORMAT: {req.format}
TARGET DURATION: {est_duration}
LANGUAGE: {req.language}

RESEARCH FINDINGS:
{research_context}

Also provide:
1. A killer hook (first line of the script)
2. Three title options for this video

Write the complete script now. Start with the hook, follow the structure, end with CTA.
After the script, on separate lines write:
HOOK: [the hook text]
TITLE1: [first title option]
TITLE2: [second title option]
TITLE3: [third title option]"""

    # Use Sonnet for script quality
    raw = await ask_claude(prompt, system=SYSTEM_PROMPT, model=MODEL, max_tokens=8192)

    # Parse hook and titles from the end of the response
    lines = raw.strip().split("\n")
    hook = ""
    title_options: list[str] = []
    script_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("HOOK:"):
            hook = stripped[5:].strip()
        elif stripped.startswith("TITLE1:") or stripped.startswith("TITLE2:") or stripped.startswith("TITLE3:"):
            title_options.append(stripped.split(":", 1)[1].strip())
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
    )
