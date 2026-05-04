"""
Caption writer — Instagram captions + optimised hashtag sets via Claude.

IDENTITY-SAFETY CONTRACT (closed-beta v4.14.126+):
The SYSTEM_PROMPT is computed per request from the authenticated creator's
profile (via `get_profile(...)`). It MUST NOT carry hardcoded political,
religious, dietary, ideological, or branded hashtag pools, and MUST NOT
hardcode the output language. The hashtag strategy is purely structural
(volume tiers + creator-pillar-driven). Language defaults to the creator's
saved `primary_content_language` when present; otherwise the model is
instructed to mirror the input topic's language.

Regression context: v4.14.118 closed the markdown-prompt leaks for
`secretary.md` / `content.md` / etc., and `script_writer.py` was migrated
to a per-request creator block. caption_writer.py was missed in that pass
and continued to inject founder-shaped political, faith, and dietary
hashtag pools (including the carnivore-diet and personal-brand pools)
plus a hardcoded `LANGUAGE: Portuguese PT-BR` override into every
authenticated user's caption generation. The closed-beta hardening pass
(2026-05-03) sanitized this file to the same per-request creator-block
pattern.
"""

import time
import logging
from models.requests import CaptionRequest, CaptionResponse
from services.claude_client import ask_claude_json
from services.creator_profile import get_profile

logger = logging.getLogger("content-engine.caption")


def _build_system_prompt(creator_block: str) -> str:
    """Build the system prompt from the per-request creator profile.

    The creator_block carries the authenticated creator's worldview,
    audience, voice, language defaults, and pillar/hashtag preferences
    (when saved). The prompt itself contains NO ideology, dietary, faith,
    political, or branded vocabulary — only structural guidance about
    caption shape and hashtag tiering.
    """
    return f"""You are the authenticated creator's Instagram caption writer.

{creator_block}

CAPTION STRUCTURE:
Line 1: HOOK — stop the scroll (bold statement, controversy, or shocking data) in the creator's saved voice
Line 2-3: Value / Context — why this matters to the creator's saved target audience
Line 4-5: the authenticated creator's take — their personal opinion, experience, or hot take, in their saved voice
Line 6: CTA — provocative question to drive comments (do NOT use generic phrasing like "comment below")

HASHTAG STRATEGY (structural — do not invent ideological, political, religious, or dietary tags):
- 15-20 hashtags per post.
- Mix volume tiers: ~5 high-volume (>1M posts) + ~5 medium (100K–1M) + ~5 niche (<100K) + ~5 trending/branded.
- Pull niche/branded tags ONLY from the creator's saved pillars and tag library in the creator profile above.
- If the creator profile does not list a relevant tag for a pillar, omit it rather than fabricating one.
- Do NOT inject political, religious, dietary, ideological, or persona hashtags that are not present in the creator's saved configuration.

LANGUAGE:
- Use the creator's saved `primary_content_language` from the creator profile above when present.
- If unspecified, mirror the language of the supplied TOPIC.
- Match the creator's saved brand voice — direct or measured, opinionated or neutral, formal or casual — exactly as configured. Do NOT default to a single voice archetype.

Return JSON with "caption" (string with \\n for line breaks) and "hashtags" (array of strings without # prefix).
No markdown wrapping."""


async def generate(req: CaptionRequest) -> CaptionResponse:
    start = time.monotonic()

    # NOTE: per-request creator block. CaptionRequest does not yet carry an
    # explicit `creator_profile`/`user_id`/`tenant_id` (tracked as P2 in
    # the closed-beta identity-safety audit — extend its model to mirror
    # ScriptRequest as a follow-up). Until then the fallback is the
    # NEUTRAL TEMPLATE in prompts/creator-config.md, which carries no
    # founder/owner identity. A unit-test guard
    # (`__tests__/security/creator-config-neutrality.test.ts`) fails CI if
    # that template ever regains a name token.
    creator_block = get_profile()
    system_prompt = _build_system_prompt(creator_block)

    prompt = f"""Write an Instagram caption for the authenticated creator's post:
- Topic: {req.topic}
- Niche: {req.niche}
- Platform: {req.platform}

The caption should sound like the authenticated creator talking to their saved target audience (use the audience profile and voice from creator memory; do not assume a default demographic, language, persona, or worldview).
Be true to the creator's saved tone and end with a question that fits their audience.

Return JSON: {{"caption": "...", "hashtags": ["tag1", "tag2", ...]}}
Include 15-20 hashtags. Caption should be 5-7 lines."""

    result = await ask_claude_json(prompt, system=system_prompt)
    caption = result.get("caption", "") if isinstance(result, dict) else ""
    hashtags = result.get("hashtags", []) if isinstance(result, dict) else []

    duration_ms = int((time.monotonic() - start) * 1000)
    return CaptionResponse(
        topic=req.topic,
        caption=caption,
        hashtags=hashtags,
        duration_ms=duration_ms,
    )
