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


def build_briefs(scored: list[ScoredResult], max_briefs: int = 10) -> list[ContentBrief]:
    """Transform top-scored results into actionable content briefs."""
    briefs: list[ContentBrief] = []

    for item in scored[:max_briefs]:
        r = item.result
        niche = _detect_niche(item)
        fmt = _pick_format(niche, r.source)
        title = _clean(r.title)
        short_title = title.split("—")[0].strip()

        brief = ContentBrief(
            title=title,
            hook=f"Você não vai acreditar no que está acontecendo com {short_title}...",
            angle="Felipe's unique perspective: real-life experience + world observations → growth mindset",
            format=fmt,
            niche=niche,
            key_points=[
                f"Context: {r.snippet[:100]}",
                "Connect to personal experience",
                "Actionable takeaway for the audience",
            ],
            title_options=[
                title,
                f"A VERDADE sobre {short_title}",
                f"Ninguém está falando disso: {short_title}",
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
            why_now=r.snippet[:200] if r.snippet else "Trending now",
        )
        briefs.append(brief)

    return briefs
