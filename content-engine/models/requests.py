from pydantic import BaseModel, Field
from .research import ContentBrief, SourceReference, TrendingTopic


class DeepSearchRequest(BaseModel):
    """Request body for /deepsearch endpoint."""
    query: str = Field(min_length=1)
    niches: list[str] = Field(default_factory=list)  # empty = search all niches
    max_results: int = Field(default=10, ge=1, le=30)


class DeepSearchResponse(BaseModel):
    """Response from /deepsearch — ranked content briefs."""
    query: str
    briefs: list[ContentBrief]
    search_count: int                         # how many searcher calls were made
    duration_ms: int                          # total wall-clock time


class SourcesResponse(BaseModel):
    """Response from /sources — curated source list for a topic."""
    query: str
    sources: list[SourceReference]


class HotNewsResponse(BaseModel):
    """Response from /hotnews — what's trending right now."""
    topics: list[TrendingTopic]
    generated_at: str                         # ISO timestamp


class TrendingResponse(BaseModel):
    """Response from /trending — cross-platform trending topics."""
    topics: list[TrendingTopic]
    niche: str
    duration_ms: int
    generated_at: str


class ReactionResponse(BaseModel):
    """Response from /reaction — reaction-worthy content briefs."""
    query: str
    briefs: list[ContentBrief]
    duration_ms: int


# ── Phase 3: Creative Intelligence ────────────────────────────────

class HooksRequest(BaseModel):
    """Request body for /hooks endpoint."""
    topic: str = Field(min_length=1)
    niche: str = Field(default="general")
    format: str = Field(default="YouTube")       # YouTube | Short | Reel | Carousel
    count: int = Field(default=8, ge=1, le=20)


class HooksResponse(BaseModel):
    """Response from /hooks — generated hooks for a topic."""
    topic: str
    niche: str
    hooks: list[dict]                             # {text, trigger_type, score, why}
    duration_ms: int


class ScriptRequest(BaseModel):
    """Request body for /script endpoint."""
    topic: str = Field(min_length=1)
    niche: str = Field(default="general")
    format: str = Field(default="YouTube")
    language: str = Field(default="pt-BR")
    max_duration_minutes: int = Field(default=8, ge=1, le=30)


class ScriptResponse(BaseModel):
    """Response from /script — full video script."""
    topic: str
    script: str                                   # the full script text
    hook: str
    title_options: list[str]
    sources_used: list[SourceReference]
    estimated_duration: str
    duration_ms: int


class TitlesRequest(BaseModel):
    """Request body for /titles endpoint."""
    topic: str = Field(min_length=1)
    niche: str = Field(default="general")
    platform: str = Field(default="YouTube")      # YouTube | Instagram
    count: int = Field(default=10, ge=1, le=20)


class TitlesResponse(BaseModel):
    """Response from /titles — A/B title variants."""
    topic: str
    titles: list[dict]                            # {title, strategy, score, why}
    duration_ms: int


class ThumbnailRequest(BaseModel):
    """Request body for /thumbnail endpoint."""
    title: str = Field(min_length=1)
    topic: str = Field(default="")
    niche: str = Field(default="general")


class ThumbnailResponse(BaseModel):
    """Response from /thumbnail — thumbnail concept descriptions."""
    title: str
    concepts: list[dict]                          # {layout, colors, text, expression, why}
    duration_ms: int


class CaptionRequest(BaseModel):
    """Request body for /caption endpoint."""
    topic: str = Field(min_length=1)
    niche: str = Field(default="general")
    platform: str = Field(default="Instagram")


class CaptionResponse(BaseModel):
    """Response from /caption — Instagram caption + hashtags."""
    topic: str
    caption: str
    hashtags: list[str]
    duration_ms: int


# ── Phase 4: Strategic Intelligence ───────────────────────────────

class CompetitorRequest(BaseModel):
    """Request body for /competitor endpoint."""
    channel: str = Field(min_length=1)            # YouTube channel URL, handle, or 'auto'
    max_videos: int = Field(default=10, ge=1, le=50)


class CompetitorResponse(BaseModel):
    """Response from /competitor — competitor analysis."""
    channel: str
    analysis: dict                                # {title_patterns, upload_freq, engagement, ...}
    duration_ms: int


class GapsRequest(BaseModel):
    """Request body for /gaps endpoint."""
    niche: str = Field(default="fitness")
    max_gaps: int = Field(default=10, ge=1, le=20)


class GapsResponse(BaseModel):
    """Response from /gaps — content gap analysis."""
    niche: str
    gaps: list[dict]                              # {topic, gap_type, search_volume, opportunity, ...}
    duration_ms: int


class SeoRequest(BaseModel):
    """Request body for /seo endpoint."""
    topic: str = Field(min_length=1)
    platform: str = Field(default="YouTube")


class SeoResponse(BaseModel):
    """Response from /seo — keyword analysis."""
    topic: str
    clusters: list[dict]                          # {keyword, volume, difficulty, content_type, ...}
    duration_ms: int


class RepurposeRequest(BaseModel):
    """Request body for /repurpose endpoint."""
    topic: str = Field(min_length=1)
    original_format: str = Field(default="YouTube")


class RepurposeResponse(BaseModel):
    """Response from /repurpose — content atomization plan."""
    topic: str
    outputs: list[dict]                           # {format, platform, content, posting_delay, ...}
    duration_ms: int


# ── Phase 5: Learning System ─────────────────────────────────────

class FeedbackRequest(BaseModel):
    """Request body for /feedback endpoint."""
    video_url: str = Field(min_length=1)
    views: int = Field(ge=0)
    retention_pct: float = Field(ge=0, le=100)
    likes: int = Field(default=0, ge=0)
    comments: int = Field(default=0, ge=0)
    subs_gained: int = Field(default=0, ge=0)
    hook_used: str = Field(default="")
    notes: str = Field(default="")


class FeedbackResponse(BaseModel):
    """Response from /feedback — analysis of logged performance."""
    status: str
    analysis: dict                                # {vs_average, insights, learnings}
    duration_ms: int


class ReportResponse(BaseModel):
    """Response from /report — weekly/monthly content report."""
    period: str
    report: dict                                  # {videos_published, total_views, best, worst, ...}
    duration_ms: int
