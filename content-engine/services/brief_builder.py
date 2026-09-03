import re

from models.research import ContentBrief, source_reference_from_search_result
from models.scoring import ScoredResult


def _detect_niche(result: ScoredResult, allowed_niches: list[str] | None) -> str:
    """Select only from caller-authorized creator niches; never infer a default identity."""
    normalized_niches = [
        " ".join(niche.split())[:160]
        for niche in (allowed_niches or [])[:12]
        if isinstance(niche, str) and niche.strip()
    ]
    if not normalized_niches:
        return "general"
    if len(normalized_niches) == 1:
        return normalized_niches[0]

    text = f"{result.result.title} {result.result.snippet}".lower()
    best_niche = "general"
    best_count = 0
    for niche in normalized_niches:
        keywords = [token for token in re.findall(r"[^\W_]+", niche.lower(), flags=re.UNICODE) if len(token) > 2]
        count = sum(1 for keyword in keywords if keyword in text)
        if count > best_count:
            best_niche = niche
            best_count = count
    return best_niche


def _pick_format(source: str) -> str:
    """Use a conservative fallback format without inferring an editorial persona."""
    if source == "youtube":
        return "YouTube"
    return "YouTube"


def _clean(text: str) -> str:
    """Strip mock prefixes — no-op once real searchers are plugged in."""
    return text.replace("[Mock] ", "")


def _is_portuguese(language: str | None) -> bool:
    return (language or "").strip().lower().startswith("pt")


def _is_brazilian_portuguese(language: str | None) -> bool:
    return (language or "").strip().lower() == "pt-br"


def _fallback_hook(short_title: str, language: str | None) -> str:
    if _is_brazilian_portuguese(language):
        return f"O que esta fonte sugere sobre {short_title} merece uma análise cuidadosa."
    if _is_portuguese(language):
        return f"O que esta fonte sugere sobre {short_title} merece uma análise cuidada."
    return f"What this source suggests about {short_title} deserves a careful look."


def _fallback_angle(language: str | None) -> str:
    if _is_brazilian_portuguese(language):
        return "Brief de fallback baseado no contexto limitado da fonte; valide as principais alegações antes de gravar."
    if _is_portuguese(language):
        return "Brief de fallback baseado em contexto limitado da fonte; valida as alegações principais antes de gravar."
    return "Fallback brief based on limited source context; validate the strongest claims before recording."


def _source_relevance_note(score: float, language: str | None) -> str:
    if _is_portuguese(language):
        return f"Pontuação de relevância da pesquisa: {score:.2f}"
    return f"Search relevance score: {score:.2f}"


def _is_time_sensitive(result: ScoredResult) -> bool:
    if result.score.recency < 0.8:
        return False
    text = f"{result.result.title} {result.result.snippet}".lower()
    return any(marker in text for marker in (
        "today", "latest", "breaking", "current", "this week", "hoje", "agora",
        "última hora", "esta semana", "atual", "recente",
    ))


def _fallback_titles(title: str, short_title: str, language: str | None) -> list[str]:
    if _is_portuguese(language):
        return [
            title,
            f"O que esta fonte mostra sobre {short_title}",
            f"Vale a pena falar sobre {short_title} agora?",
        ]
    return [
        title,
        f"What this source shows about {short_title}",
        f"Is {short_title} worth covering now?",
    ]


def _fallback_why_now(language: str | None) -> str:
    if _is_brazilian_portuguese(language):
        return "Brief de fallback gerado com o contexto limitado da fonte disponível."
    if _is_portuguese(language):
        return "Brief de fallback gerado com contexto limitado da fonte disponível."
    return "Fallback brief generated from limited available source context."


def build_briefs(
    scored: list[ScoredResult],
    max_briefs: int = 10,
    language: str | None = "en-US",
    allowed_niches: list[str] | None = None,
) -> list[ContentBrief]:
    """Transform top-scored results into actionable content briefs."""
    briefs: list[ContentBrief] = []

    for item in scored[:max_briefs]:
        r = item.result
        niche = _detect_niche(item, allowed_niches)
        fmt = _pick_format(r.source)
        title = _clean(r.title)
        short_title = title.split("—")[0].strip()
        brief = ContentBrief(
            title=title,
            hook=_fallback_hook(short_title, language),
            angle=_fallback_angle(language),
            format=fmt,
            niche=niche,
            key_points=[],
            title_options=_fallback_titles(title, short_title, language),
            sources=[
                source_reference_from_search_result(
                    r,
                    relevance_note=_source_relevance_note(item.score.composite, language),
                    title=title,
                )
            ],
            score=item.score.composite,
            time_sensitive=_is_time_sensitive(item),
            # External snippets remain source evidence, not an authored reason
            # or public claim. The title/URL provenance is retained in sources.
            why_now=_fallback_why_now(language),
        )
        briefs.append(brief)

    return briefs
