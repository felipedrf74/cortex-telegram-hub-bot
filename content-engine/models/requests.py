from typing import Literal

from pydantic import BaseModel, Field
from .research import ContentBrief, SourceReference, TrendingTopic


class AttributionFields(BaseModel):
    """Server-trusted attribution propagated by the TypeScript backend."""
    user_id: int | None = Field(default=None)
    tenant_id: int | None = Field(default=None)
    internal_attribution_token: str | None = Field(default=None)
    source_package_id: str | None = Field(default=None)
    voice_card_version: str | None = Field(default=None)
    draft_id: str | None = Field(default=None)
    script_id: str | None = Field(default=None)
    reuse_policy: Literal["prefer_reuse", "force_refresh", "no_research"] | None = Field(default=None)
    quality_tier: Literal["fast", "standard", "strict"] | None = Field(default=None)
    operation_mode: Literal["draft", "pack", "rewrite", "expand", "research_refresh"] | None = Field(default=None)


class ContentOperationMetadata(BaseModel):
    operation_trace: dict | None = Field(default=None)
    artifact_refs: list[dict] = Field(default_factory=list)
    next_actions: list[dict] = Field(default_factory=list)
    reuse_status: str | None = Field(default=None)
    cost_tier: str | None = Field(default=None)
    quality_report: dict | None = Field(default=None)
    claim_ledger: list[dict] = Field(default_factory=list)
    agent_signals_used: list[dict] = Field(default_factory=list)


class DeepSearchRequest(AttributionFields):
    """Request body for /deepsearch endpoint."""
    query: str = Field(min_length=1)
    niches: list[str] = Field(default_factory=list)  # empty = search all niches
    max_results: int = Field(default=10, ge=1, le=30)
    language: str = Field(default="en-US")
    creator_profile: str | None = Field(default=None)


class DeepSearchResponse(BaseModel):
    """Response from /deepsearch — ranked content briefs."""
    query: str
    briefs: list[ContentBrief]
    search_count: int                         # how many searcher calls were made
    duration_ms: int                          # total wall-clock time
    degraded: bool = False
    warnings: list[str] = Field(default_factory=list)


class SourcesResponse(BaseModel):
    """Response from /sources — curated source list for a topic."""
    query: str
    sources: list[SourceReference]


class HotNewsRequest(AttributionFields):
    """Request body for /hotnews when caller has authenticated creator context."""
    language: str = Field(default="en-US")
    creator_profile: str | None = Field(default=None)


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

class HooksRequest(AttributionFields):
    """Request body for /hooks endpoint."""
    topic: str = Field(min_length=1)
    niche: str = Field(default="general")
    format: str = Field(default="YouTube")       # YouTube | Short | Reel | Carousel
    count: int = Field(default=8, ge=1, le=20)
    language: str = Field(default="en-US")
    brand_voice: str | None = Field(default=None)
    creator_profile: str | None = Field(default=None)


class HooksResponse(ContentOperationMetadata):
    """Response from /hooks — generated hooks for a topic."""
    topic: str
    niche: str
    hooks: list[dict]                             # {text, trigger_type, score, why}
    duration_ms: int
    degraded: bool = False
    warnings: list[str] = Field(default_factory=list)


class ScriptRequest(BaseModel):
    """Request body for /script endpoint."""
    topic: str = Field(min_length=1)
    niche: str = Field(default="general")
    format: str = Field(default="YouTube")
    mode: Literal["draft", "quick", "standard", "deep"] = Field(default="draft")
    language: str = Field(default="pt-BR")
    render_mode: str = Field(default="structured")
    script_style: str = Field(default="detailed")
    max_duration_minutes: int = Field(default=8, ge=1, le=30)
    target_duration_seconds: int | None = Field(default=None, ge=15, le=900)
    topic_context: dict | None = Field(default=None)
    context_signals: list[dict] | None = Field(default=None)  # Intelligence bus signals
    brand_voice: str | None = Field(default=None)
    creator_profile: str | None = Field(default=None)
    user_id: int | None = Field(default=None)
    tenant_id: int | None = Field(default=None)
    internal_attribution_token: str | None = Field(default=None)
    force_refresh: bool = Field(default=False)
    regeneration_seed: str | None = Field(default=None)


class ScriptResponse(BaseModel):
    """Response from /script — full video script."""
    topic: str
    script: str                                   # the full script text
    hook: str
    title_options: list[str]
    sources_used: list[SourceReference]
    estimated_duration: str
    duration_ms: int
    # Creator-pack fields (April 2026) — structured for iOS/portal rendering
    hashtags: list[str] = []                      # e.g., ["#ai", "#tech"]
    caption: str = ""                             # social media caption/post copy
    cta: str = ""                                 # call to action text
    degraded: bool = False
    warnings: list[str] = Field(default_factory=list)
    generation_mode: str | None = Field(default=None)
    cache_status: str | None = Field(default=None)
    research_artifact_id: str | None = Field(default=None)
    source_package_id: str | None = Field(default=None)
    voice_card_version: str | None = Field(default=None)
    quality_score: int | None = Field(default=None)
    quality_warnings: list[str] = Field(default_factory=list)
    budget_state: str | None = Field(default=None)
    expand_options: list[dict] = Field(default_factory=list)
    estimated_cost: dict | None = Field(default=None)
    actual_cost: dict | None = Field(default=None)
    prompt_budget: dict | None = Field(default=None)
    research_route: dict | None = Field(default=None)


class TitlesRequest(AttributionFields):
    """Request body for /titles endpoint."""
    topic: str = Field(min_length=1)
    niche: str = Field(default="general")
    platform: str = Field(default="YouTube")      # YouTube | Instagram
    count: int = Field(default=10, ge=1, le=20)
    language: str = Field(default="en-US")
    brand_voice: str | None = Field(default=None)
    creator_profile: str | None = Field(default=None)


class TitlesResponse(ContentOperationMetadata):
    """Response from /titles — A/B title variants."""
    topic: str
    titles: list[dict]                            # {title, strategy, score, why}
    duration_ms: int


class ThumbnailRequest(AttributionFields):
    """Request body for /thumbnail endpoint."""
    title: str = Field(min_length=1)
    topic: str = Field(default="")
    niche: str = Field(default="general")
    language: str = Field(default="en-US")
    brand_voice: str | None = Field(default=None)
    creator_profile: str | None = Field(default=None)


class ThumbnailResponse(ContentOperationMetadata):
    """Response from /thumbnail — thumbnail concept descriptions."""
    title: str
    concepts: list[dict]                          # {layout, colors, text, expression, why}
    duration_ms: int


class CaptionRequest(AttributionFields):
    """Request body for /caption endpoint."""
    topic: str = Field(min_length=1)
    niche: str = Field(default="general")
    platform: str = Field(default="Instagram")
    language: str = Field(default="en-US")
    brand_voice: str | None = Field(default=None)
    creator_profile: str | None = Field(default=None)


class CaptionResponse(ContentOperationMetadata):
    """Response from /caption — Instagram caption + hashtags."""
    topic: str
    caption: str
    hashtags: list[str]
    duration_ms: int


# ── Phase 4: Strategic Intelligence ───────────────────────────────

class CompetitorRequest(AttributionFields):
    """Request body for /competitor endpoint."""
    channel: str = Field(min_length=1)            # YouTube channel URL, handle, or 'auto'
    max_videos: int = Field(default=10, ge=1, le=50)
    language: str = Field(default="en-US")
    brand_voice: str | None = Field(default=None)
    creator_profile: str | None = Field(default=None)


class CompetitorResponse(ContentOperationMetadata):
    """Response from /competitor — competitor analysis."""
    channel: str
    analysis: dict                                # {title_patterns, upload_freq, engagement, ...}
    duration_ms: int


class GapsRequest(AttributionFields):
    """Request body for /gaps endpoint."""
    niche: str = Field(default="fitness")
    max_gaps: int = Field(default=10, ge=1, le=20)


class GapsResponse(ContentOperationMetadata):
    """Response from /gaps — content gap analysis."""
    niche: str
    gaps: list[dict]                              # {topic, gap_type, search_volume, opportunity, ...}
    duration_ms: int


class SeoRequest(AttributionFields):
    """Request body for /seo endpoint."""
    topic: str = Field(min_length=1)
    platform: str = Field(default="YouTube")
    language: str = Field(default="en-US")
    brand_voice: str | None = Field(default=None)
    creator_profile: str | None = Field(default=None)


class SeoResponse(ContentOperationMetadata):
    """Response from /seo — keyword analysis."""
    topic: str
    clusters: list[dict]                          # {keyword, volume, difficulty, content_type, ...}
    duration_ms: int


class RepurposeRequest(AttributionFields):
    """Request body for /repurpose endpoint."""
    topic: str = Field(min_length=1)
    original_format: str = Field(default="YouTube")
    language: str = Field(default="en-US")
    brand_voice: str | None = Field(default=None)
    creator_profile: str | None = Field(default=None)


class RepurposeResponse(ContentOperationMetadata):
    """Response from /repurpose — content atomization plan."""
    topic: str
    outputs: list[dict]                           # {format, platform, content, posting_delay, ...}
    duration_ms: int


# ── Phase 5: Learning System ─────────────────────────────────────

class FeedbackRequest(AttributionFields):
    """Request body for /feedback endpoint."""
    video_url: str = Field(min_length=1)
    views: int = Field(ge=0)
    retention_pct: float = Field(ge=0, le=100)
    likes: int = Field(default=0, ge=0)
    comments: int = Field(default=0, ge=0)
    subs_gained: int = Field(default=0, ge=0)
    hook_used: str = Field(default="")
    notes: str = Field(default="")
    language: str = Field(default="en-US")
    brand_voice: str | None = Field(default=None)
    creator_profile: str | None = Field(default=None)


class FeedbackResponse(BaseModel):
    """Response from /feedback — analysis of logged performance."""
    status: str
    analysis: dict                                # {vs_average, insights, learnings}
    duration_ms: int


class ReportRequest(AttributionFields):
    """Request body for /report when called from an authenticated TS route."""
    period: str = Field(default="week")
    language: str = Field(default="en-US")
    creator_profile: str | None = Field(default=None)


class ReportResponse(BaseModel):
    """Response from /report — weekly/monthly content report."""
    period: str
    report: dict                                  # {videos_published, total_views, best, worst, ...}
    duration_ms: int
