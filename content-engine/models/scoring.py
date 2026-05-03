from pydantic import BaseModel, Field
from .research import SearchResult


class ScoreBreakdown(BaseModel):
    """Individual scoring dimensions for a search result."""
    relevance: float = Field(ge=0.0, le=1.0, default=0.0)   # how relevant to the authenticated creator's niches
    virality: float = Field(ge=0.0, le=1.0, default=0.0)    # shareability / engagement potential
    recency: float = Field(ge=0.0, le=1.0, default=0.0)     # how fresh (today > yesterday > last week)
    composite: float = Field(ge=0.0, le=1.0, default=0.0)   # weighted final score


class ScoredResult(BaseModel):
    """A search result with its scoring breakdown attached."""
    result: SearchResult
    score: ScoreBreakdown
