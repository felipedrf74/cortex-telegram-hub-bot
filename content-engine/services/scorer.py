from datetime import datetime, timezone
from typing import Iterable, Optional
from models.research import SearchResult
from models.scoring import ScoreBreakdown, ScoredResult

# Scoring weights for the bounded research-result ranker. The legacy
# ``virality`` response field carries only a source-normalized observed
# engagement signal; it is never a prediction of future performance.
WEIGHT_RELEVANCE = 0.40
WEIGHT_VIRALITY = 0.30
WEIGHT_RECENCY = 0.30

def _relevance_score(
    result: SearchResult,
    creator_keywords: Optional[Iterable[str]] = None,
) -> float:
    """How relevant is this result to the authenticated creator's saved niches?

    When `creator_keywords` is provided, relevance is computed against the
    creator's own saved pillar keywords. When omitted, relevance is zero rather
    than inferred from a hardcoded creator identity.
    """
    text = f"{result.title} {result.snippet}".lower()
    keyword_pool = [kw for kw in creator_keywords if kw] if creator_keywords is not None else []

    if not keyword_pool:
        return 0.0

    matches = sum(1 for kw in keyword_pool if kw.lower() in text)
    return min(matches / 3.0, 1.0)  # 3+ keyword hits = max relevance


def _virality_score(result: SearchResult) -> float:
    """Return an observed engagement signal without inventing a platform rule.

    ``virality`` is retained as the public compatibility field name. Raw view,
    vote, and comment totals are not comparable across platforms, channel
    sizes, audience ages, or collection windows, so they never create a score
    here. A search adapter may supply ``normalized_engagement_score`` only
    when it has already normalized the metric to the source cohort on [0, 1].
    Missing, boolean, non-finite, or out-of-range evidence yields zero rather
    than a fabricated neutral baseline.
    """
    value = result.metadata.get("normalized_engagement_score")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    normalized = float(value)
    if normalized != normalized or normalized in {float("inf"), float("-inf")}:
        return 0.0
    return normalized if 0.0 <= normalized <= 1.0 else 0.0


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

    Pass `creator_keywords` to use the authenticated creator's saved pillar
    keywords for relevance matching; omit to leave relevance at zero.
    """
    relevance = _relevance_score(result, creator_keywords=creator_keywords)
    # API compatibility retains the field name ``virality`` even though this
    # value is only normalized observed engagement, never predicted reach.
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
    `pillar_keywords` from creator memory) to score against the creator's own
    pillars. When omitted, relevance remains zero; recency and any explicitly
    source-normalized observed engagement evidence drive the ranking.
    """
    # Materialize the iterable once so we don't exhaust it across N calls.
    keywords_list = list(creator_keywords) if creator_keywords is not None else None
    scored = [score_result(r, creator_keywords=keywords_list) for r in results]
    scored.sort(key=lambda s: s.score.composite, reverse=True)
    return scored
