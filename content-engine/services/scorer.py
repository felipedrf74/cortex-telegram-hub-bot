from datetime import datetime, timezone
from models.research import SearchResult
from models.scoring import ScoreBreakdown, ScoredResult

# Scoring weights — edit these to shift what the engine prioritizes
WEIGHT_RELEVANCE = 0.40
WEIGHT_VIRALITY = 0.30
WEIGHT_RECENCY = 0.30

# The Operator content pillars — used for relevance keyword matching
NICHE_KEYWORDS: dict[str, list[str]] = {
    "ai-tech": [
        "ai", "artificial intelligence", "machine learning", "claude", "gpt", "chatgpt",
        "automation", "bot", "api", "coding", "programming", "devops", "terraform",
        "docker", "kubernetes", "tech", "build",
    ],
    "commentary": [
        "reaction", "react", "controversy", "viral", "trending", "drama", "opinion",
        "take", "hot take", "commentary", "culture", "politics", "government", "state",
        "libertarian", "conservative",
    ],
    "training": [
        "triathlon", "running", "cycling", "swimming", "gym", "strength", "training",
        "workout", "carnivore", "diet", "recovery", "garmin", "athlete", "marathon",
        "ironman",
    ],
    "gaming": [
        "game", "gaming", "gta", "resident evil", "counter-strike", "cs2", "steam",
        "playstation", "xbox", "nintendo",
    ],
    "wild-card": [],  # catch-all for anything not matching above
}


def _relevance_score(result: SearchResult) -> float:
    """How relevant is this result to Felipe's content niches?"""
    text = f"{result.title} {result.snippet}".lower()
    matches = 0
    total_keywords = 0
    for keywords in NICHE_KEYWORDS.values():
        total_keywords += len(keywords)
        matches += sum(1 for kw in keywords if kw.lower() in text)
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


def score_result(result: SearchResult) -> ScoredResult:
    """Score a single search result across all dimensions."""
    relevance = _relevance_score(result)
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


def score_results(results: list[SearchResult]) -> list[ScoredResult]:
    """Score and rank results by composite score (descending)."""
    scored = [score_result(r) for r in results]
    scored.sort(key=lambda s: s.score.composite, reverse=True)
    return scored
