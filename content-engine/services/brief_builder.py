import re

from models.research import ContentBrief, SourceReference
from models.scoring import ScoredResult
from .scorer import NICHE_KEYWORDS


def _detect_niche(result: ScoredResult) -> str:
    """Best-effort niche detection from title/snippet keywords."""
    text = f"{result.result.title} {result.result.snippet}".lower()
    best_niche = "general"
    best_count = 0
    for niche, keywords in NICHE_KEYWORDS.items():
        count = sum(1 for kw in keywords if kw in text)
        if count > best_count:
            best_niche = niche
            best_count = count
    return best_niche


def _pick_format(niche: str, source: str) -> str:
    """Suggest content format based on niche and source type."""
    if source == "youtube":
        return "YouTube"
    if niche in ("trending", "politics"):
        return "Short"  # hot takes work best as Shorts/Reels
    return "YouTube"


def _clean(text: str) -> str:
    """Strip mock prefixes — no-op once real searchers are plugged in."""
    return text.replace("[Mock] ", "")


def _clean_snippet(text: str) -> str:
    cleaned = _clean(text or "")
    cleaned = re.sub(r"Mock [^.]+\.?", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"Set [A-Z_]+ to get real results\.?", "", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" .")
    return cleaned


def build_briefs(scored: list[ScoredResult], max_briefs: int = 10) -> list[ContentBrief]:
    """Transform top-scored results into actionable content briefs."""
    briefs: list[ContentBrief] = []

    for item in scored[:max_briefs]:
        r = item.result
        niche = _detect_niche(item)
        fmt = _pick_format(niche, r.source)
        title = _clean(r.title)
        short_title = title.split("—")[0].strip()
        cleaned_snippet = _clean_snippet(r.snippet)

        brief = ContentBrief(
            title=title,
            hook=f"O que esta fonte sugere sobre {short_title} merece um olhar crítico.",
            angle="Fallback brief based on limited source context — validate the strongest claims before recording.",
            format=fmt,
            niche=niche,
            key_points=[],
            title_options=[
                title,
                f"O que esta fonte mostra sobre {short_title}",
                f"Vale a pena falar sobre {short_title} agora?",
            ],
            sources=[
                SourceReference(
                    title=title,
                    url=r.url,
                    source_type=r.source,
                    relevance_note=f"Score: {item.score.composite:.2f}",
                )
            ],
            score=item.score.composite,
            time_sensitive=item.score.recency >= 0.8,
            why_now=cleaned_snippet[:200] if cleaned_snippet else "Fallback brief generated from limited available source context.",
        )
        briefs.append(brief)

    return briefs
