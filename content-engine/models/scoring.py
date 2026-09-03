from pydantic import BaseModel, ConfigDict, Field, field_validator
from .research import SearchResult


class ScoreBreakdown(BaseModel):
    """Individual scoring dimensions for a search result."""
    model_config = ConfigDict(extra="forbid")

    relevance: float = Field(ge=0.0, le=1.0, allow_inf_nan=False, default=0.0)   # how relevant to the authenticated creator's niches
    # Legacy compatibility name: source-normalized observed engagement only,
    # never predicted virality, reach, or platform performance.
    virality: float = Field(ge=0.0, le=1.0, allow_inf_nan=False, default=0.0)
    recency: float = Field(ge=0.0, le=1.0, allow_inf_nan=False, default=0.0)     # how fresh (today > yesterday > last week)
    composite: float = Field(ge=0.0, le=1.0, allow_inf_nan=False, default=0.0)   # weighted final score

    @field_validator("relevance", "virality", "recency", "composite", mode="before")
    @classmethod
    def require_numeric_scores(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("score dimensions must be numeric")
        return value


class ScoredResult(BaseModel):
    """A search result with its scoring breakdown attached."""
    model_config = ConfigDict(extra="forbid")

    result: SearchResult
    score: ScoreBreakdown
