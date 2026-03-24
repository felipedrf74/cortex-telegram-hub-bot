from datetime import datetime
from pydantic import BaseModel, Field


class SearchResult(BaseModel):
    """A single result from any searcher (web, YouTube, news, etc.)."""
    title: str
    url: str
    snippet: str = ""
    source: str = ""                          # e.g. "web", "youtube", "news"
    published_at: datetime | None = None
    thumbnail_url: str | None = None
    metadata: dict = Field(default_factory=dict)  # searcher-specific extras


class SourceReference(BaseModel):
    """A curated source with relevance context."""
    title: str
    url: str
    source_type: str                          # "article", "video", "social", "news"
    relevance_note: str = ""                  # why this source matters


class TrendingTopic(BaseModel):
    """A trending topic detected across sources."""
    topic: str
    heat_score: float = Field(ge=0.0, le=1.0)  # 0=cold, 1=volcanic
    sources: list[str] = Field(default_factory=list)
    first_seen: datetime | None = None
    niche: str = ""                           # which content niche it fits
    content_angle: str = ""                   # how Felipe should approach this topic
    relevance: int = 5                        # 1-10 brand relevance score


class ContentBrief(BaseModel):
    """The final deliverable: a complete content brief for one idea."""
    title: str
    hook: str                                 # scroll-stopping first line (PT-BR)
    angle: str                                # what makes Felipe's take unique
    format: str                               # "YouTube" | "Short" | "Reel" | "Carousel"
    niche: str
    key_points: list[str] = Field(default_factory=list)
    title_options: list[str] = Field(default_factory=list)  # SEO-friendly variations
    sources: list[SourceReference] = Field(default_factory=list)
    score: float = 0.0                        # composite content score
    time_sensitive: bool = False              # expires in 24-48h?
    why_now: str = ""                         # what makes this trending TODAY
