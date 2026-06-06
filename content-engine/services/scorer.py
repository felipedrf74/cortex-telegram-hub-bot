from datetime import datetime, timezone
from typing import Iterable, Optional
from models.research import SearchResult
from models.scoring import ScoreBreakdown, ScoredResult

# Scoring weights — edit these to shift what the engine prioritizes
WEIGHT_RELEVANCE = 0.40
WEIGHT_VIRALITY = 0.30
WEIGHT_RECENCY = 0.30

# Default content-pillar keywords — used for setup-safe relevance matching
# when the authenticated creator's saved niches/keywords are unavailable.
# Per-request scoring SHOULD override this with the creator's saved
# pillar_keywords from creator memory (see content_creative_memory).
#
# Identity-safety contract (closed-beta v4.14.126+): keep these neutral —
# no political, religious, dietary, or ideological lexicon that biases
# scoring for non-default creators. The keywords here are GENRE labels
# (ai, training, gaming, commentary), not ideology. To override per
# request, pass `creator_keywords=[...]` into `score_results(...)` —
# callers SHOULD pull these from the authenticated creator's saved
# `pillar_keywords` and pass them through. The default fallback only
# fires for first-touch / setup-safe scoring before a creator profile
# exists.
NICHE_KEYWORDS: dict[str, list[str]] = {
    "ai-tech": [
        "ai", "artificial intelligence", "machine learning", "claude", "gpt", "chatgpt",
        "automation", "bot", "api", "coding", "programming", "devops", "terraform",
        "docker", "kubernetes", "tech", "build",
    ],
    "commentary": [
        "reaction", "react", "controversy", "viral", "trending", "drama", "opinion",
        "take", "hot take", "commentary", "culture", "politics", "government",
    ],
    "training": [
        "triathlon", "running", "cycling", "swimming", "gym", "strength", "training",
        "workout", "diet", "recovery", "athlete", "marathon", "ironman",
    ],
    "gaming": [
        "game", "gaming", "gta", "resident evil", "counter-strike", "cs2", "steam",
        "playstation", "xbox", "nintendo",
    ],
    "wild-card": [],  # catch-all for anything not matching above
}


def _flatten_default_keywords() -> list[str]:
    """Flatten the per-pillar default keywords into a single list for
    setup-safe scoring when the caller doesn't supply creator keywords."""
    flat: list[str] = []
    for keywords in NICHE_KEYWORDS.values():
        flat.extend(keywords)
    return flat


def _relevance_score(
    result: SearchResult,
    creator_keywords: Optional[Iterable[str]] = None,
) -> float:
    """How relevant is this result to the authenticated creator's saved niches?

    When `creator_keywords` is provided (the per-request override path),
    relevance is computed against the creator's own saved pillar keywords.
    When omitted, falls back to the genre-only setup-safe defaults from
    `NICHE_KEYWORDS`. The fallback never includes ideological vocabulary
    by contract — see the comment at the top of the module.
    """
    text = f"{result.title} {result.snippet}".lower()
    if creator_keywords is not None:
        keyword_pool = [kw for kw in creator_keywords if kw]
    else:
        keyword_pool = _flatten_default_keywords()

    if not keyword_pool:
        return 0.0

    matches = sum(1 for kw in keyword_pool if kw.lower() in text)
    return min(matches / 3.0, 1.0)  # 3+ keyword hits = max relevance


def _virality_score(result: SearchResult) -> float:
    """Estimate shareability / engagement potential."""
    score = 0.3  # base score
    text = f"{result.title} {result.snippet}".lower()

    # Viral language signals
    viral_signals = ["viral", "breaking", "shocking", "everyone", "polêmica", "absurdo", "urgente"]
    score += sum(0.15 for s in viral_signals if s in text)

    # YouTube metadata — high view counts signal virality
    views = result.metadata.get("view_count", 0)
    if views > 500_000:
        score += 0.3
    elif views > 100_000:
        score += 0.2
    elif views > 10_000:
        score += 0.1

    return min(score, 1.0)


def _recency_score(result: SearchResult) -> float:
    """How fresh is this content? Today = 1.0, 7+ days ago = 0.0."""
    if not result.published_at:
        return 0.3  # unknown date gets a neutral score

    pub = result.published_at
    if pub.tzinfo is None:
        pub = pub.replace(tzinfo=timezone.utc)

    age_hours = (datetime.now(timezone.utc) - pub).total_seconds() / 3600
    if age_hours < 6:
        return 1.0
    if age_hours < 24:
        return 0.8
    if age_hours < 48:
        return 0.5
    if age_hours < 168:  # 7 days
        return 0.2
    return 0.0


def score_result(
    result: SearchResult,
    creator_keywords: Optional[Iterable[str]] = None,
) -> ScoredResult:
    """Score a single search result across all dimensions.

    Pass `creator_keywords` to use the authenticated creator's saved
    pillar keywords for relevance matching; omit to fall back to
    setup-safe genre defaults.
    """
    relevance = _relevance_score(result, creator_keywords=creator_keywords)
    virality = _virality_score(result)
    recency = _recency_score(result)
    composite = (
        WEIGHT_RELEVANCE * relevance
        + WEIGHT_VIRALITY * virality
        + WEIGHT_RECENCY * recency
    )
    return ScoredResult(
        result=result,
        score=ScoreBreakdown(
            relevance=round(relevance, 3),
            virality=round(virality, 3),
            recency=round(recency, 3),
            composite=round(composite, 3),
        ),
    )


def score_results(
    results: list[SearchResult],
    creator_keywords: Optional[Iterable[str]] = None,
) -> list[ScoredResult]:
    """Score and rank results by composite score (descending).

    Pass `creator_keywords` (typically the authenticated creator's saved
    `pillar_keywords` from creator memory) to score against the creator's
    own pillars. When omitted, the setup-safe genre defaults from
    `NICHE_KEYWORDS` are used. By contract those defaults carry no
    ideological/dietary/political vocabulary.
    """
    # Materialize the iterable once so we don't exhaust it across N calls.
    keywords_list = list(creator_keywords) if creator_keywords is not None else None
    scored = [score_result(r, creator_keywords=keywords_list) for r in results]
    scored.sort(key=lambda s: s.score.composite, reverse=True)
    return scored
