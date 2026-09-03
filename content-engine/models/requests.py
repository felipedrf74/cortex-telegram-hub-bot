import re
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, AliasChoices, BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from .research import ContentBrief, SourceReference, TrendingTopic


BoundedAttributionToken = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=8_192, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedInferenceProofKey = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=1_024, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedArtifactReference = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=256, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedSourceSummaryLine = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=220, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedOperationMetadataText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedOperationMetadataIdentity = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"),
]
ContentOperationKind = Literal[
    "hook_pack",
    "title_pack",
    "caption_pack",
    "thumbnail_pack",
    "cta_pack",
    "shorts_cutdown",
    "repurpose",
    "competitor_insight",
    "seo_insight",
    "gap_insight",
    "book_source",
]


class AttributionFields(BaseModel):
    """Server-trusted attribution propagated by the TypeScript backend."""
    model_config = ConfigDict(extra="forbid")

    user_id: int | None = Field(default=None, gt=0, le=9_007_199_254_740_991, strict=True)
    tenant_id: int | None = Field(default=None, gt=0, le=9_007_199_254_740_991, strict=True)
    internal_attribution_token: BoundedAttributionToken | None = None
    internal_inference_attribution_token: BoundedAttributionToken | None = None
    internal_inference_proof_key: BoundedInferenceProofKey | None = None
    source_package_id: BoundedArtifactReference | None = None
    source_summary: list[BoundedSourceSummaryLine] = Field(default_factory=list, max_length=8)
    source_reuse_status: Literal["fresh", "refreshed", "reused", "none"] | None = None
    voice_card_version: BoundedArtifactReference | None = None
    draft_id: BoundedArtifactReference | None = None
    script_id: BoundedArtifactReference | None = None


class ContentOperationPromptSection(BaseModel):
    """Bounded telemetry for one compiled prompt section."""

    model_config = ConfigDict(extra="forbid")

    sectionName: BoundedOperationMetadataIdentity
    inputTokens: int = Field(ge=0, le=1_000_000, strict=True)
    truncated: bool = Field(strict=True)


class ContentOperationTracePayload(BaseModel):
    """Exact operation trace emitted by ``build_operation_metadata``."""

    model_config = ConfigDict(extra="forbid")

    operation: ContentOperationKind
    provider: Literal["content-engine"]
    model: Literal["provider-routed"]
    inputTokens: int = Field(ge=0, le=1_000_000, strict=True)
    systemPromptTokens: int = Field(ge=0, le=1_000_000, strict=True)
    userPromptTokens: int = Field(ge=0, le=1_000_000, strict=True)
    promptTokenBudget: int = Field(ge=1, le=1_000_000, strict=True)
    promptEnvelopeTokenTarget: int = Field(ge=1, le=1_000_000, strict=True)
    outputTokenBudget: int = Field(ge=1, le=1_000_000, strict=True)
    cacheStatus: Literal["miss"]
    cacheablePrefixHash: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{16}$")]
    cacheablePrefixReady: bool = Field(strict=True)
    promptSections: list[ContentOperationPromptSection] = Field(max_length=16)
    latencyMs: int | None = Field(default=None, ge=0, le=86_400_000, strict=True)

    @model_validator(mode="after")
    def require_consistent_token_accounting(self) -> "ContentOperationTracePayload":
        if self.inputTokens != self.systemPromptTokens + self.userPromptTokens:
            raise ValueError("operation trace input token accounting is inconsistent")
        if self.promptTokenBudget != self.promptEnvelopeTokenTarget:
            raise ValueError("operation trace prompt envelope targets are inconsistent")
        if self.cacheablePrefixReady is not bool(self.cacheablePrefixHash):
            raise ValueError("operation trace cache-prefix readiness is inconsistent")
        return self


class ContentOperationArtifactRef(BaseModel):
    """Bounded request artifact reference accepted by operation metadata."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["source_package", "voice_card", "draft", "script"]
    id: BoundedArtifactReference
    source: Literal["request"]


class ContentOperationNextAction(BaseModel):
    """Bounded deterministic follow-up action emitted for an operation."""

    model_config = ConfigDict(extra="forbid")

    id: Literal[
        "generate_draft",
        "refresh_research",
        "rewrite_tone",
        "turn_into_draft",
        "create_script_from_reference",
    ]
    label: BoundedOperationMetadataText
    kind: Literal["draft", "research_refresh", "rewrite"]
    costTier: Literal["low", "medium", "high"]


class ContentOperationQualityReport(BaseModel):
    """Bounded deterministic quality state for operation assembly."""

    model_config = ConfigDict(extra="forbid")

    tier: Literal["fast", "standard", "strict"]
    warnings: list[Literal[
        "prompt_over_budget",
        "prompt_section_truncated",
        "no_source_data",
        "research_source_unavailable",
        "provider_output_invalid",
    ]] = Field(default_factory=list, max_length=10)


class ContentOperationClaimLedgerEntry(BaseModel):
    """Bounded optional claim-ledger entry; source binding is not verification."""

    model_config = ConfigDict(extra="forbid")

    claim: BoundedOperationMetadataText
    support: Literal["source_bound", "source_backed", "creator_memory_backed", "unverified"]
    sourceRef: BoundedArtifactReference | None = None
    sourceRefs: list[BoundedArtifactReference] = Field(default_factory=list, max_length=12)
    suggestedSourceRefs: list[BoundedArtifactReference] = Field(default_factory=list, max_length=12)


class ContentOperationAgentSignal(BaseModel):
    """Bounded identity-only digest of an intelligence signal used by generation."""

    model_config = ConfigDict(extra="forbid")

    type: BoundedOperationMetadataIdentity
    source: BoundedOperationMetadataIdentity


class ContentOperationMetadata(BaseModel):
    """Typed metadata envelope for non-script Content operations."""

    model_config = ConfigDict(extra="forbid")

    operation_trace: ContentOperationTracePayload | None = Field(default=None)
    artifact_refs: list[ContentOperationArtifactRef] = Field(default_factory=list, max_length=8)
    next_actions: list[ContentOperationNextAction] = Field(default_factory=list, max_length=5)
    reuse_status: Literal["fresh", "refreshed", "reused", "none"] | None = Field(default=None)
    cost_tier: Literal["low", "medium", "high"] | None = Field(default=None)
    quality_report: ContentOperationQualityReport | None = Field(default=None)
    claim_ledger: list[ContentOperationClaimLedgerEntry] = Field(default_factory=list, max_length=50)
    agent_signals_used: list[ContentOperationAgentSignal] = Field(default_factory=list, max_length=20)


BoundedCreatorNiche = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120, pattern=r"^[^\x00-\x1f\x7f]+$")]
BoundedCreativeTopic = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000, pattern=r"^[^\x00-\x1f\x7f]+$")]
BoundedCreativeNiche = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160, pattern=r"^[^\x00-\x1f\x7f]+$")]
BoundedCreativeSelector = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80, pattern=r"^[^\x00-\x1f\x7f]+$")]
BoundedCreativeLanguage = Literal["en-US", "pt-PT", "pt-BR"]
BoundedBrandVoice = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000, pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$")]
BoundedCreatorProfile = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=6_000, pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$")]
BoundedOutputText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=500, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedOutputDetail = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedHashtag = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
BoundedResponseWarning = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=2_000,
        pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$",
    ),
]
BoundedOptionalOutputText = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        max_length=2_200,
        pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$",
    ),
]
BoundedDurationMs = Annotated[int, Field(ge=0, le=86_400_000, strict=True)]
SCRIPT_RESEARCH_QUERY_MAX_CHARS = 2_000


def build_script_research_query(topic: str, niche: str | None) -> str:
    """Build the canonical server-side research subject without truncation."""
    normalized_topic = " ".join((topic or "").split())
    normalized_niche = " ".join((niche or "").split())
    if not normalized_topic:
        raise ValueError("script topic is required for the research query")
    if not normalized_niche or normalized_niche.casefold() == "general":
        subject = normalized_topic
    else:
        subject = f"TOPIC: {normalized_topic} | NICHE: {normalized_niche}"
    if len(subject) > SCRIPT_RESEARCH_QUERY_MAX_CHARS:
        raise ValueError(
            f"script research query exceeds the {SCRIPT_RESEARCH_QUERY_MAX_CHARS}-character grounding boundary"
        )
    return subject


class DeepSearchRequest(AttributionFields):
    """Request body for /deepsearch endpoint."""
    query: BoundedCreativeTopic
    niches: list[BoundedCreatorNiche] = Field(default_factory=list, max_length=12)  # empty = search all niches
    max_results: int = Field(default=10, ge=1, le=30, strict=True)
    language: BoundedCreativeLanguage = "en-US"
    creator_profile: BoundedCreatorProfile | None = None


class DeepSearchResponse(BaseModel):
    """Response from /deepsearch — ranked content briefs."""
    model_config = ConfigDict(extra="forbid")

    query: BoundedCreativeTopic
    briefs: list[ContentBrief] = Field(max_length=30)
    search_count: int = Field(ge=0, le=1_000, strict=True)  # how many searcher calls were made
    duration_ms: BoundedDurationMs             # total wall-clock time
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=30)


class SourcesResponse(BaseModel):
    """Response from /sources — curated source list for a topic."""
    model_config = ConfigDict(extra="forbid")

    query: BoundedCreativeTopic
    sources: list[SourceReference] = Field(max_length=30)
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)


class HotNewsRequest(AttributionFields):
    """Request body for /hotnews when caller has authenticated creator context."""
    language: BoundedCreativeLanguage = "en-US"
    creator_profile: BoundedCreatorProfile | None = None


class HotNewsResponse(BaseModel):
    """Response from /hotnews — what's trending right now."""
    model_config = ConfigDict(extra="forbid")

    topics: list[TrendingTopic] = Field(max_length=30)
    generated_at: AwareDatetime                # timezone-aware ISO timestamp
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)

    @field_validator("generated_at", mode="before")
    @classmethod
    def require_explicit_timestamp_input(cls, value: object) -> object:
        if not isinstance(value, (str, datetime)):
            raise ValueError("generated_at must be an ISO-8601 string or aware datetime")
        if isinstance(value, str) and (not value.strip() or len(value) > 64 or value != value.strip()):
            raise ValueError("generated_at must be a bounded canonical timestamp")
        return value


class TrendingResponse(BaseModel):
    """Response from /trending — cross-platform trending topics."""
    model_config = ConfigDict(extra="forbid")

    topics: list[TrendingTopic] = Field(max_length=30)
    niche: BoundedCreativeNiche
    duration_ms: BoundedDurationMs
    generated_at: AwareDatetime
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)

    @field_validator("generated_at", mode="before")
    @classmethod
    def require_explicit_timestamp_input(cls, value: object) -> object:
        if not isinstance(value, (str, datetime)):
            raise ValueError("generated_at must be an ISO-8601 string or aware datetime")
        if isinstance(value, str) and (not value.strip() or len(value) > 64 or value != value.strip()):
            raise ValueError("generated_at must be a bounded canonical timestamp")
        return value


class ReactionResponse(BaseModel):
    """Response from /reaction — reaction-worthy content briefs."""
    model_config = ConfigDict(extra="forbid")

    query: BoundedCreativeTopic
    briefs: list[ContentBrief] = Field(max_length=30)
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)


# ── Phase 3: Creative Intelligence ────────────────────────────────


class HookVariant(BaseModel):
    """Bounded provider-authored hook returned by /hooks."""
    model_config = ConfigDict(extra="forbid")

    text: BoundedOutputText
    trigger_type: Literal[
        "curiosity_gap",
        "bold_claim",
        "data_shock",
        "controversy",
        "identity",
        "urgency",
        "story",
        "contrarian",
        "challenge",
        "build_reveal",
        "reaction_opener",
        "raw_moment",
    ]
    score: float = Field(ge=0, le=10, allow_inf_nan=False)
    why: BoundedOutputDetail
    sfx: BoundedCreativeSelector
    edit_cue: BoundedOutputText

    @field_validator("score", mode="before")
    @classmethod
    def reject_boolean_score(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("score must be numeric")
        return value


class TitleVariant(BaseModel):
    """Bounded provider-authored title candidate returned by /titles."""
    model_config = ConfigDict(extra="forbid")

    title: BoundedOutputText
    strategy: Literal[
        "NUMBER",
        "QUESTION",
        "HOW_TO",
        "BOLD_CLAIM",
        "VS",
        "STORY",
        "CONTROVERSY",
        "URGENCY",
        "CONTRARIAN",
    ]
    score: float = Field(ge=0, le=100, allow_inf_nan=False)
    why: BoundedOutputDetail
    char_count: int = Field(default=0, ge=0, le=500, strict=True)

    @model_validator(mode="before")
    @classmethod
    def ignore_provider_character_count(cls, value: object) -> object:
        # char_count is server-authored output metadata, not a provider trust
        # decision. Normalize any omitted or malformed provider guess before
        # field validation, then compute the canonical count below.
        if isinstance(value, dict):
            return {**value, "char_count": 0}
        return value

    @field_validator("score", mode="before")
    @classmethod
    def reject_boolean_score(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("score must be numeric")
        return value

    @model_validator(mode="after")
    def compute_canonical_character_count(self) -> "TitleVariant":
        # Python Unicode code points are the canonical API count. Provider
        # guesses are ignored so counting mistakes cannot degrade a valid pack.
        self.char_count = len(self.title)
        return self


class ThumbnailTextOverlay(BaseModel):
    """Bounded text direction nested in a thumbnail concept."""
    model_config = ConfigDict(extra="forbid")

    main_text: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=160, pattern=r"^[^\x00-\x1f\x7f]+$"),
    ]
    font_style: Literal[
        "sans-serif", "serif", "condensed", "display", "monospace", "script", "bold",
    ]
    color: BoundedCreativeSelector
    position: Literal[
        "center", "top", "bottom", "left", "right",
        "top-left", "top-center", "top-right",
        "middle-left", "middle-right",
        "bottom-left", "bottom-center", "bottom-right",
    ]

    @field_validator("color")
    @classmethod
    def require_hex_color(cls, value: str) -> str:
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
            raise ValueError("thumbnail overlay color must be exactly one six-digit hex color")
        return value


class ThumbnailConcept(BaseModel):
    """Bounded provider-authored visual direction returned by /thumbnail."""
    model_config = ConfigDict(extra="forbid")

    layout: Literal[
        "split_screen",
        "close_up",
        "text_heavy",
        "before_after",
        "subject_detail",
        "process_demo",
        "screenshot_focus",
        "diagram",
    ]
    text_overlay: ThumbnailTextOverlay
    why_it_works: BoundedOutputDetail
    background_color: BoundedOutputText
    facial_expression: Literal["", "neutral", "focused", "surprised", "skeptical", "excited", "determined"]
    additional_elements: list[BoundedOutputText] = Field(max_length=30)

    @field_validator("background_color")
    @classmethod
    def require_hex_background(cls, value: str) -> str:
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
            raise ValueError("background_color must be exactly one six-digit hex color")
        return value


class CaptionGenerationPayload(BaseModel):
    """Bounded provider payload used to construct /caption responses."""
    model_config = ConfigDict(extra="forbid")

    caption: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=2_200,
            pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$",
        ),
    ]
    hashtags: list[BoundedHashtag] = Field(max_length=20)

    @field_validator("hashtags")
    @classmethod
    def require_plain_unique_hashtags(cls, value: list[str]) -> list[str]:
        if any("#" in hashtag for hashtag in value):
            raise ValueError("hashtags must not include the # prefix")
        if any(not all(character.isalnum() or character == "_" for character in hashtag) for hashtag in value):
            raise ValueError("hashtags must be single alphanumeric or underscore tokens")
        normalized = [hashtag.casefold() for hashtag in value]
        if len(normalized) != len(set(normalized)):
            raise ValueError("hashtags must be unique")
        return value


class CompetitorAnalysisPayload(BaseModel):
    """Bounded provider payload for competitor intelligence."""
    model_config = ConfigDict(extra="forbid")

    channel: BoundedOutputText | None = None
    title_patterns: list[BoundedOutputText] = Field(default_factory=list, max_length=20)
    content_mix: dict[BoundedCreativeSelector, BoundedOutputDetail] = Field(default_factory=dict, max_length=20)
    upload_frequency: BoundedOutputText | None = None
    avg_views: float | None = Field(default=None, ge=0, le=9_007_199_254_740_991, allow_inf_nan=False)
    top_performer: BoundedOutputDetail | None = None
    strengths: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    weaknesses: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    actionable_insights: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    confidence: Literal["low", "medium", "high"] | None = None

    @field_validator("avg_views", mode="before")
    @classmethod
    def require_numeric_average_views(cls, value: object) -> object:
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError("avg_views must be numeric")
        return value

    @model_validator(mode="after")
    def require_recognized_analysis(self) -> "CompetitorAnalysisPayload":
        # ``channel`` is request-owned and ``confidence`` is server-forced to
        # low when research is unavailable. Neither is substantive model
        # analysis, so metadata-only provider output must be withheld.
        if not any((
            self.title_patterns,
            self.content_mix,
            self.upload_frequency,
            self.avg_views is not None,
            self.top_performer,
            self.strengths,
            self.weaknesses,
            self.actionable_insights,
        )):
            raise ValueError("competitor analysis contains no substantive fields")
        return self


class GapInsightPayload(BaseModel):
    """Bounded provider-authored content-gap candidate."""
    model_config = ConfigDict(extra="forbid")

    topic: BoundedOutputText
    gap_type: Literal["big_opportunity", "quality_gap", "saturated"]
    search_demand: Literal["high", "medium", "low"] | None = None
    existing_content_quality: Literal["none", "low", "medium", "high"] | None = None
    opportunity_score: float | None = Field(default=None, ge=0, le=10, allow_inf_nan=False)
    suggested_angle: BoundedOutputDetail | None = None
    suggested_title: BoundedOutputText | None = None

    @field_validator("opportunity_score", mode="before")
    @classmethod
    def require_numeric_opportunity_score(cls, value: object) -> object:
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError("opportunity_score must be numeric")
        return value


class SeoClusterPayload(BaseModel):
    """Bounded provider-authored SEO cluster."""
    model_config = ConfigDict(extra="forbid")

    keyword: BoundedOutputText
    variations: list[BoundedOutputText] = Field(default_factory=list, max_length=30)
    estimated_volume: Literal["high", "medium", "low"] | None = None
    competition: Literal["high", "medium", "low"] | None = None
    opportunity_score: float | None = Field(default=None, ge=0, le=10, allow_inf_nan=False)
    content_type: BoundedCreativeSelector | None = None
    suggested_title: BoundedOutputText | None = None
    notes: BoundedOutputDetail | None = None

    @field_validator("opportunity_score", mode="before")
    @classmethod
    def require_numeric_opportunity_score(cls, value: object) -> object:
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError("opportunity_score must be numeric")
        return value


class FeedbackAnalysisPayload(BaseModel):
    """Bounded provider-authored analysis for one persisted feedback row."""
    model_config = ConfigDict(extra="forbid")

    performance_level: Literal["exceptional", "above_average", "average", "below_average", "poor"]
    strengths: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    weaknesses: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    learnings: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    hook_analysis: BoundedOutputDetail | None = None
    recommendations: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)


class ReportPerformerPayload(BaseModel):
    """Bounded optional best/worst performer detail."""
    model_config = ConfigDict(extra="forbid")

    title: BoundedOutputText | None = None
    views: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991, strict=True)
    retention_pct: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    summary: BoundedOutputDetail | None = None
    reason: BoundedOutputDetail | None = None

    @field_validator("retention_pct", mode="before")
    @classmethod
    def require_numeric_retention(cls, value: object) -> object:
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError("retention_pct must be numeric")
        return value

    @model_validator(mode="after")
    def require_recognized_detail(self) -> "ReportPerformerPayload":
        if not any((self.title, self.views is not None, self.retention_pct is not None, self.summary, self.reason)):
            raise ValueError("performer detail contains no recognized fields")
        return self


class ReportAnalysisPayload(BaseModel):
    """Bounded provider-authored interpretation of canonical performance metrics."""
    model_config = ConfigDict(extra="forbid")

    total_views: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991, strict=True)
    avg_retention: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    best_performer: BoundedOutputDetail | ReportPerformerPayload | None = None
    worst_performer: BoundedOutputDetail | ReportPerformerPayload | None = None
    top_insights: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    recommendations: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    hook_analysis: BoundedOutputDetail | None = None
    trend_direction: Literal["improving", "stable", "declining"] | None = None

    @field_validator("avg_retention", mode="before")
    @classmethod
    def require_numeric_average_retention(cls, value: object) -> object:
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError("avg_retention must be numeric")
        return value

    @model_validator(mode="after")
    def require_recognized_report(self) -> "ReportAnalysisPayload":
        # Aggregate metrics are recomputed from the canonical performance
        # store before returning the response. Provider-supplied copies alone
        # are not an interpretation and must not make the report available.
        if not any((
            self.best_performer,
            self.worst_performer,
            self.top_insights,
            self.recommendations,
            self.hook_analysis,
            self.trend_direction,
        )):
            raise ValueError("performance report contains no substantive fields")
        return self

class RepurposeOutput(BaseModel):
    """Bounded provider-authored atomized content item returned by /repurpose."""
    model_config = ConfigDict(extra="forbid")

    format: BoundedCreativeSelector
    platform: BoundedCreativeSelector
    content: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=12_000,
            pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$",
        ),
    ]
    posting_delay: Annotated[
        str,
        StringConstraints(strip_whitespace=True, pattern=r"^(?:unspecified|\+[1-9][0-9]{0,2}[hd])$"),
    ]
    notes: BoundedOutputDetail

    @field_validator("posting_delay")
    @classmethod
    def require_bounded_relative_posting_delay(cls, value: str) -> str:
        if value == "unspecified":
            return value
        amount = int(value[1:-1])
        if (value.endswith("h") and amount > 168) or (value.endswith("d") and amount > 30):
            raise ValueError("posting_delay exceeds the supported 7-day/30-day relative horizon")
        return value


class HooksRequest(AttributionFields):
    """Request body for /hooks endpoint."""
    topic: BoundedCreativeTopic
    niche: BoundedCreativeNiche = "general"
    format: Literal["YouTube", "Short", "Reel", "Carousel"] = "YouTube"
    count: int = Field(default=8, ge=1, le=8, strict=True)
    language: BoundedCreativeLanguage = "en-US"
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None


class HooksResponse(ContentOperationMetadata):
    """Response from /hooks — generated hooks for a topic."""
    topic: BoundedCreativeTopic
    niche: BoundedCreativeNiche
    hooks: list[HookVariant] = Field(max_length=8)
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=20)


BoundedTopicContextText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedTopicContextTag = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=160, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedTopicContextSource = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=120, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:-]*$"),
]


class ScriptTopicContext(BaseModel):
    """Bounded first-party topic metadata supplied by the authenticated TS backend."""
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    idea_id: int | None = Field(default=None, alias="ideaId", gt=0, le=9_007_199_254_740_991, strict=True)
    pipeline_id: int | None = Field(default=None, alias="pipelineId", gt=0, le=9_007_199_254_740_991, strict=True)
    topic_feedback_id: int | None = Field(default=None, alias="topicFeedbackId", gt=0, le=9_007_199_254_740_991, strict=True)
    niche: BoundedCreativeNiche | None = None
    hook_idea: BoundedTopicContextText | None = Field(default=None, alias="hookIdea")
    why_now: BoundedTopicContextText | None = Field(default=None, alias="whyNow")
    angle_tag: BoundedTopicContextTag | None = Field(default=None, alias="angleTag")
    source_job: BoundedTopicContextSource | None = Field(default=None, alias="sourceJob")


BoundedAgentSignalText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedAgentSignalIdentity = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, min_length=1, max_length=120, pattern=r"^[a-z0-9][a-z0-9._:-]*$"),
]


class ScriptAgentSignalFramework(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: BoundedAgentSignalText


class ScriptAgentSignalRanking(BaseModel):
    model_config = ConfigDict(extra="ignore")
    pillar: BoundedAgentSignalText
    trend: BoundedAgentSignalText | None = None
    avg_views: float = Field(default=0, ge=0, le=9_007_199_254_740_991, allow_inf_nan=False)

    @field_validator("avg_views", mode="before")
    @classmethod
    def require_numeric_average_views(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 0
        return value


class ScriptAgentSignalPayload(BaseModel):
    """Recognized bounded fields from Content intelligence-bus payloads."""
    model_config = ConfigDict(extra="ignore")

    recommendation: BoundedAgentSignalText | None = None
    description: BoundedAgentSignalText | None = None
    phrase: BoundedAgentSignalText | None = None
    context: BoundedAgentSignalText | None = None
    category: Literal["hook_style", "storytelling", "content_structure"] | None = None
    patterns: list[BoundedAgentSignalText] = Field(default_factory=list, max_length=10)
    channel_name: BoundedAgentSignalText | None = None
    core_thesis: BoundedAgentSignalText | None = None
    title: BoundedAgentSignalText | None = None
    key_frameworks: list[ScriptAgentSignalFramework] = Field(default_factory=list, max_length=10)
    keyword: BoundedAgentSignalText | None = None
    rankings: list[ScriptAgentSignalRanking] = Field(default_factory=list, max_length=10)

    @field_validator("patterns", mode="before")
    @classmethod
    def retain_bounded_patterns(cls, value: object) -> object:
        if not isinstance(value, list):
            return []
        return [
            normalized
            for item in value[:10]
            if isinstance(item, str)
            and (normalized := item.strip())
            and len(normalized) <= 2_000
            and not re.search(r"[\r\n\t]", normalized)
        ]

    @field_validator("key_frameworks", mode="before")
    @classmethod
    def retain_bounded_frameworks(cls, value: object) -> object:
        if not isinstance(value, list):
            return []
        bounded = []
        for item in value[:10]:
            try:
                bounded.append(ScriptAgentSignalFramework.model_validate(item))
            except (TypeError, ValueError):
                continue
        return bounded

    @field_validator("rankings", mode="before")
    @classmethod
    def retain_bounded_rankings(cls, value: object) -> object:
        if not isinstance(value, list):
            return []
        bounded = []
        for item in value[:10]:
            try:
                bounded.append(ScriptAgentSignalRanking.model_validate(item))
            except (TypeError, ValueError):
                continue
        return bounded


class ScriptAgentSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: BoundedAgentSignalIdentity
    source: BoundedAgentSignalIdentity
    payload: ScriptAgentSignalPayload = Field(default_factory=ScriptAgentSignalPayload)


class ScriptRequest(BaseModel):
    """Request body for /script with closed, format-bound runtime presets."""
    model_config = ConfigDict(extra="forbid")

    topic: BoundedCreativeTopic
    niche: BoundedCreativeNiche = "general"
    # Server-authored research subject. When supplied, script_writer requires
    # an exact match with its deterministic Topic/Niche grounding composite;
    # public output continues to use `topic`.
    research_query: BoundedCreativeTopic | None = None
    format: Literal["YouTube", "Short", "Reel"] = "YouTube"
    mode: Literal["draft", "quick", "standard", "deep"] = Field(default="draft")
    language: BoundedCreativeLanguage = "en-US"
    render_mode: Literal["structured", "chat"] = "structured"
    script_style: Literal["detailed", "bullets"] = "detailed"
    max_duration_minutes: Literal[1, 8, 10, 15] = 8
    target_duration_seconds: Literal[15, 30, 45, 60, 480, 600, 900] | None = None
    topic_context: ScriptTopicContext | None = Field(default=None)
    context_signals: list[ScriptAgentSignal] | None = Field(default=None, max_length=20)
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None
    user_id: int | None = Field(default=None, gt=0, le=9_007_199_254_740_991, strict=True)
    tenant_id: int | None = Field(default=None, gt=0, le=9_007_199_254_740_991, strict=True)
    internal_attribution_token: BoundedAttributionToken | None = None
    internal_inference_attribution_token: BoundedAttributionToken | None = None
    internal_inference_proof_key: BoundedInferenceProofKey | None = None
    force_refresh: bool = Field(default=False, strict=True)
    regeneration_seed: Annotated[
        str,
        StringConstraints(
            strict=True,
            strip_whitespace=True,
            min_length=1,
            max_length=120,
            pattern=r"^[^\x00-\x1f\x7f]+$",
        ),
    ] | None = None

    @model_validator(mode="before")
    @classmethod
    def apply_format_duration_default(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        format_name = normalized.get("format", "YouTube")
        if format_name in {"Short", "Reel"} and "max_duration_minutes" not in normalized:
            normalized["max_duration_minutes"] = 1
        return normalized

    @field_validator("max_duration_minutes", "target_duration_seconds", mode="before")
    @classmethod
    def require_strict_duration_integer(cls, value: object) -> object:
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("script duration presets must be integers")
        return value

    @model_validator(mode="after")
    def require_format_duration_presets(self) -> "ScriptRequest":
        short_form = self.format in {"Short", "Reel"}
        allowed_minutes = {1} if short_form else {8, 10, 15}
        allowed_seconds = {15, 30, 45, 60} if short_form else {480, 600, 900}
        if self.max_duration_minutes not in allowed_minutes:
            raise ValueError(
                f"max_duration_minutes is not a supported {self.format} duration preset"
            )
        if self.target_duration_seconds is not None and self.target_duration_seconds not in allowed_seconds:
            raise ValueError(
                f"target_duration_seconds is not a supported {self.format} duration preset"
            )
        # Both fields remain valid input for compatibility. The script service
        # treats target_duration_seconds as authoritative when it is supplied.
        return self

    @field_validator("context_signals", mode="before")
    @classmethod
    def retain_only_bounded_agent_signals(cls, value: object) -> object:
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("context_signals must be a list")
        if len(value) > 20:
            raise ValueError("context_signals exceeds the supported limit")
        bounded: list[ScriptAgentSignal] = []
        for signal in value:
            try:
                bounded.append(ScriptAgentSignal.model_validate(signal))
            except (TypeError, ValueError):
                continue
        return bounded

BoundedScriptBody = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=80_000,
        pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$",
    ),
]
BoundedScriptMetadataLine = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=500,
        pattern=r"^[^\x00-\x1f\x7f]+$",
    ),
]
BoundedScriptCaption = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=2_200,
        pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$",
    ),
]
BoundedScriptHashtag = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=2, max_length=120),
]


class ScriptGenerationBody(BaseModel):
    """Bounded provider-authored script body that can be salvaged independently."""
    model_config = ConfigDict(extra="ignore")

    script: BoundedScriptBody = Field(
        validation_alias=AliasChoices("script", "body", "spoken_script", "spokenScript", "outline"),
    )


class ScriptRecoveredMetadata(BaseModel):
    """Optional bounded metadata accepted only by the legacy line parser."""
    model_config = ConfigDict(extra="ignore")

    hook: BoundedScriptMetadataLine | None = Field(default=None, validation_alias=AliasChoices("hook", "gancho"))
    titles: list[BoundedScriptMetadataLine] = Field(
        default_factory=list,
        max_length=5,
        validation_alias=AliasChoices("titles", "title_options", "titleOptions"),
    )
    hashtags: list[BoundedScriptHashtag] = Field(default_factory=list, max_length=8)
    caption: BoundedScriptCaption | None = Field(default=None, validation_alias=AliasChoices("caption", "legenda"))
    cta: BoundedScriptMetadataLine | None = Field(
        default=None,
        validation_alias=AliasChoices("cta", "call_to_action", "callToAction"),
    )

    @field_validator("hashtags")
    @classmethod
    def require_plain_unique_hashtags(cls, value: list[str]) -> list[str]:
        if any(
            not hashtag.startswith("#")
            or not hashtag[1:]
            or not all(character.isalnum() or character in {"_", "-"} for character in hashtag[1:])
            for hashtag in value
        ):
            raise ValueError("script hashtags must be # prefixed single tokens")
        normalized = [hashtag.casefold() for hashtag in value]
        if len(normalized) != len(set(normalized)):
            raise ValueError("script hashtags must be unique")
        return value


class ScriptGenerationMetadata(ScriptRecoveredMetadata):
    """Exact mandatory metadata contract for canonical provider JSON output."""
    model_config = ConfigDict(extra="forbid")

    hook: BoundedScriptMetadataLine = Field(validation_alias=AliasChoices("hook", "gancho"))
    titles: list[BoundedScriptMetadataLine] = Field(
        min_length=1,
        max_length=5,
        validation_alias=AliasChoices("titles", "title_options", "titleOptions"),
    )
    hashtags: list[BoundedScriptHashtag] = Field(max_length=8)
    caption: BoundedScriptCaption = Field(validation_alias=AliasChoices("caption", "legenda"))
    cta: BoundedScriptMetadataLine = Field(
        validation_alias=AliasChoices("cta", "call_to_action", "callToAction"),
    )


class ScriptGenerationPayload(ScriptGenerationMetadata):
    """Exact bounded structure accepted from a JSON script generation response."""

    script: BoundedScriptBody = Field(
        validation_alias=AliasChoices("script", "body", "spoken_script", "spokenScript", "outline"),
    )


class ScriptExpandOption(BaseModel):
    """Bounded server-authored follow-up exposed with a generated script."""
    model_config = ConfigDict(extra="forbid")

    id: Literal["expand-full", "expand-intro", "rewrite-hook", "refresh-research", "change-cta"]
    label: BoundedScriptMetadataLine
    action: Literal[
        "expand_full",
        "expand_section:intro",
        "rewrite_hook",
        "refresh_research",
        "change_cta",
    ]


class ScriptEstimatedCost(BaseModel):
    """Bounded estimate only; provider billing truth remains outside this engine."""
    model_config = ConfigDict(extra="forbid")

    estimatedInputTokens: int = Field(ge=0, le=1_000_000, strict=True)
    estimatedOutputTokens: int = Field(ge=0, le=1_000_000, strict=True)
    costConfidence: Literal["low", "medium", "high"]


class ScriptActualCost(BaseModel):
    """Bounded execution telemetry without claiming provider billing amounts."""
    model_config = ConfigDict(extra="forbid")

    durationMs: BoundedDurationMs
    providerMeteredBy: Literal["none_provider_fallback", "ts-internal-ai-complete"]


class ScriptPromptBudgetSection(BaseModel):
    """One bounded prompt-budget section emitted by the local compiler."""
    model_config = ConfigDict(extra="forbid")

    sectionName: BoundedOperationMetadataIdentity
    tokenEstimate: int = Field(ge=0, le=1_000_000, strict=True)
    required: bool = Field(strict=True)
    cacheable: bool = Field(strict=True)
    source: BoundedOperationMetadataIdentity
    truncated: bool = Field(strict=True)


class ScriptPromptBudget(BaseModel):
    """Exact bounded prompt compiler telemetry returned with a script."""
    model_config = ConfigDict(extra="forbid")

    tokenEstimate: int = Field(ge=0, le=1_000_000, strict=True)
    maxTokens: int = Field(ge=1, le=1_000_000, strict=True)
    outputTokenBudget: int | None = Field(default=None, ge=1, le=1_000_000, strict=True)
    overBudget: bool = Field(strict=True)
    cacheablePrefixHash: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{16}$")]
    sections: list[ScriptPromptBudgetSection] = Field(max_length=20)


class ScriptResearchRoute(BaseModel):
    """Deterministic, server-authored research policy applied to the script."""
    model_config = ConfigDict(extra="forbid")

    route: Literal[
        "unsupported",
        "high_risk_review",
        "creator_only",
        "deep_explicit",
        "fresh_compact",
        "evergreen_cached",
    ]
    allowDeepSearch: bool = Field(strict=True)
    reason: Literal[
        "unsafe_or_abusive_topic",
        "high_risk_topic_requires_source_grounding",
        "creator_context_only",
        "explicit_deep_mode",
        "timely_or_refresh_compact_research",
        "draft_or_evergreen_default",
    ]
    groundingSubject: BoundedCreativeTopic


class ScriptAgentSignalUsed(BaseModel):
    """Identity-only signal acknowledgement; private payloads never cross back."""
    model_config = ConfigDict(extra="forbid")

    type: BoundedAgentSignalIdentity
    source: BoundedAgentSignalIdentity


class ScriptResponse(BaseModel):
    """Response from /script — full video script."""
    model_config = ConfigDict(extra="forbid")

    topic: BoundedCreativeTopic
    script: BoundedScriptBody                     # the full script text
    hook: BoundedScriptMetadataLine
    title_options: list[BoundedScriptMetadataLine] = Field(max_length=5)
    sources_used: list[SourceReference] = Field(max_length=10)
    estimated_duration: Annotated[
        str,
        StringConstraints(strict=True, strip_whitespace=True, pattern=r"^[0-9]{1,2}:[0-5][0-9]$"),
    ]
    duration_ms: BoundedDurationMs
    # Creator-pack fields (April 2026) — structured for iOS/portal rendering
    hashtags: list[BoundedScriptHashtag] = Field(default_factory=list, max_length=8)
    caption: BoundedScriptCaption                 # social media caption/post copy
    cta: BoundedScriptMetadataLine                # call to action text
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=30)
    generation_mode: Literal["draft", "quick", "standard", "deep"] | None = Field(default=None)
    cache_status: Literal["fresh", "fallback"] | None = Field(default=None)
    research_artifact_id: BoundedArtifactReference | None = Field(default=None)
    source_package_id: BoundedArtifactReference | None = Field(default=None)
    voice_card_version: BoundedArtifactReference | None = Field(default=None)
    quality_score: int | None = Field(default=None, ge=0, le=100, strict=True)
    quality_warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=30)
    budget_state: Literal["healthy", "over_budget"] | None = Field(default=None)
    expand_options: list[dict[str, object]] = Field(default_factory=list, max_length=5)
    estimated_cost: dict[str, object] | None = Field(default=None)
    actual_cost: dict[str, object] | None = Field(default=None)
    prompt_budget: dict[str, object] | None = Field(default=None)
    research_route: dict[str, object] | None = Field(default=None)
    agent_signals_used: list[dict[str, str]] = Field(default_factory=list, max_length=10)

    @field_validator("estimated_duration")
    @classmethod
    def require_supported_estimated_duration(cls, value: str) -> str:
        minutes, seconds = (int(part) for part in value.split(":"))
        if seconds > 59 or minutes * 60 + seconds > 1_800:
            raise ValueError("estimated_duration exceeds the supported script horizon")
        return value

    @field_validator("expand_options", mode="before")
    @classmethod
    def require_bounded_expand_options(cls, value: object) -> list[dict[str, object]]:
        if not isinstance(value, list):
            raise ValueError("expand_options must be a list")
        return [ScriptExpandOption.model_validate(item).model_dump() for item in value]

    @field_validator("estimated_cost", mode="before")
    @classmethod
    def require_bounded_estimated_cost(cls, value: object) -> dict[str, object] | None:
        if value is None:
            return None
        return ScriptEstimatedCost.model_validate(value).model_dump()

    @field_validator("actual_cost", mode="before")
    @classmethod
    def require_bounded_actual_cost(cls, value: object) -> dict[str, object] | None:
        if value is None:
            return None
        return ScriptActualCost.model_validate(value).model_dump()

    @field_validator("prompt_budget", mode="before")
    @classmethod
    def require_bounded_prompt_budget(cls, value: object) -> dict[str, object] | None:
        if value is None:
            return None
        return ScriptPromptBudget.model_validate(value).model_dump()

    @field_validator("research_route", mode="before")
    @classmethod
    def require_bounded_research_route(cls, value: object) -> dict[str, object] | None:
        if value is None:
            return None
        return ScriptResearchRoute.model_validate(value).model_dump()

    @field_validator("agent_signals_used", mode="before")
    @classmethod
    def require_bounded_agent_signal_identities(cls, value: object) -> list[dict[str, str]]:
        if not isinstance(value, list):
            raise ValueError("agent_signals_used must be a list")
        return [ScriptAgentSignalUsed.model_validate(item).model_dump() for item in value]


class TitlesRequest(AttributionFields):
    """Request body for /titles endpoint."""
    topic: BoundedCreativeTopic
    niche: BoundedCreativeNiche = "general"
    platform: Literal["YouTube", "Instagram"] = "YouTube"
    count: int = Field(default=10, ge=1, le=10, strict=True)
    language: BoundedCreativeLanguage = "en-US"
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None


class TitlesResponse(ContentOperationMetadata):
    """Response from /titles — A/B title variants."""
    topic: BoundedCreativeTopic
    titles: list[TitleVariant] = Field(max_length=10)
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)


class ThumbnailRequest(AttributionFields):
    """Request body for /thumbnail endpoint."""
    title: BoundedCreativeTopic
    topic: BoundedCreativeTopic | Literal[""] = ""
    niche: BoundedCreativeNiche = "general"
    language: BoundedCreativeLanguage = "en-US"
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None

    @field_validator("topic", mode="before")
    @classmethod
    def normalize_optional_topic(cls, value: object) -> object:
        if isinstance(value, str) and any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("thumbnail topic must not contain control characters")
        return " ".join(value.split()) if isinstance(value, str) else value

    @model_validator(mode="after")
    def require_bounded_combined_brief(self) -> "ThumbnailRequest":
        effective_topic = self.topic or self.title
        if len(self.title) + len(effective_topic) > 2_800:
            raise ValueError("thumbnail title and topic exceed the combined prompt boundary")
        return self


class ThumbnailResponse(ContentOperationMetadata):
    """Response from /thumbnail — thumbnail concept descriptions."""
    title: BoundedCreativeTopic
    concepts: list[ThumbnailConcept] = Field(max_length=3)
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)


class CaptionRequest(AttributionFields):
    """Request body for /caption endpoint."""
    topic: BoundedCreativeTopic
    niche: BoundedCreativeNiche = "general"
    platform: Literal["Instagram"] = "Instagram"
    language: BoundedCreativeLanguage = "en-US"
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None


class CaptionResponse(ContentOperationMetadata):
    """Response from /caption — Instagram caption with optional hashtags."""
    topic: BoundedCreativeTopic
    caption: BoundedOptionalOutputText
    hashtags: list[BoundedHashtag] = Field(max_length=20)
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def require_healthy_caption_payload(self) -> "CaptionResponse":
        if any("#" in hashtag for hashtag in self.hashtags):
            raise ValueError("caption response hashtags must not include the # prefix")
        if any(
            not all(character.isalnum() or character == "_" for character in hashtag)
            for hashtag in self.hashtags
        ):
            raise ValueError("caption response hashtags must be single alphanumeric or underscore tokens")
        normalized = [hashtag.casefold() for hashtag in self.hashtags]
        if len(normalized) != len(set(normalized)):
            raise ValueError("caption response hashtags must be unique")
        if not self.degraded and not self.caption:
            raise ValueError("healthy caption responses require non-empty caption text")
        return self


# ── Phase 4: Strategic Intelligence ───────────────────────────────

class CompetitorRequest(AttributionFields):
    """Request body for /competitor endpoint."""
    channel: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_048, pattern=r"^[^\x00-\x1f\x7f]+$")]  # YouTube channel URL, handle, or 'auto'
    max_videos: int = Field(default=10, ge=1, le=50, strict=True)
    language: BoundedCreativeLanguage = "en-US"
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None


class CompetitorResponse(ContentOperationMetadata):
    """Response from /competitor — competitor analysis."""
    channel: Annotated[
        str,
        StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=2_048, pattern=r"^[^\x00-\x1f\x7f]+$"),
    ]
    analysis: dict[str, object]                    # bounded by the validator below
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)

    @field_validator("analysis", mode="before")
    @classmethod
    def require_bounded_analysis(cls, value: object) -> dict[str, object]:
        if value == {}:
            return {}
        return CompetitorAnalysisPayload.model_validate(value).model_dump(exclude_none=True)


class GapsRequest(AttributionFields):
    """Request body for /gaps endpoint."""
    niche: BoundedCreativeNiche
    max_gaps: int = Field(default=10, ge=1, le=20, strict=True)
    language: BoundedCreativeLanguage = "en-US"
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None

    @field_validator("niche")
    @classmethod
    def normalize_required_niche(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("niche must be non-empty")
        return normalized


class GapsResponse(ContentOperationMetadata):
    """Response from /gaps — content gap analysis."""
    niche: BoundedCreativeNiche
    gaps: list[dict[str, object]] = Field(max_length=20)
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)

    @field_validator("gaps", mode="before")
    @classmethod
    def require_bounded_gaps(cls, value: object) -> list[dict[str, object]]:
        if not isinstance(value, list):
            raise ValueError("gaps must be a list")
        return [
            GapInsightPayload.model_validate(item).model_dump(exclude_none=True)
            for item in value
        ]


class SeoRequest(AttributionFields):
    """Request body for /seo endpoint."""
    topic: BoundedCreativeTopic
    platform: Literal["YouTube", "Instagram"] = "YouTube"
    language: BoundedCreativeLanguage = "en-US"
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None


class SeoResponse(ContentOperationMetadata):
    """Response from /seo — keyword analysis."""
    topic: BoundedCreativeTopic
    clusters: list[dict[str, object]] = Field(max_length=12)
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)

    @field_validator("clusters", mode="before")
    @classmethod
    def require_bounded_clusters(cls, value: object) -> list[dict[str, object]]:
        if not isinstance(value, list):
            raise ValueError("clusters must be a list")
        return [
            SeoClusterPayload.model_validate(item).model_dump(exclude_none=True)
            for item in value
        ]


class RepurposeRequest(AttributionFields):
    """Request body for /repurpose endpoint."""
    topic: BoundedCreativeTopic
    niche: BoundedCreativeNiche = "general"
    source_content: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=5_000,
            pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$",
        ),
    ]
    original_format: Literal["YouTube", "Short", "Reel", "Carousel", "Podcast", "Article", "Newsletter"] = "YouTube"
    language: BoundedCreativeLanguage = "en-US"
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None


class RepurposeResponse(ContentOperationMetadata):
    """Response from /repurpose — content atomization plan."""
    topic: BoundedCreativeTopic
    outputs: list[RepurposeOutput] = Field(max_length=10)
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def require_healthy_derivative_set(self) -> "RepurposeResponse":
        if not self.degraded and not self.outputs:
            raise ValueError("healthy repurpose responses require at least one derivative proposal")
        return self


# ── Phase 5: Learning System ─────────────────────────────────────

class FeedbackRequest(AttributionFields):
    """Request body for /feedback endpoint."""
    video_url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_048, pattern=r"^[^\x00-\x1f\x7f]+$")]
    views: int = Field(ge=0, le=9_007_199_254_740_991, strict=True)
    retention_pct: float = Field(ge=0, le=100, allow_inf_nan=False)
    likes: int = Field(default=0, ge=0, le=9_007_199_254_740_991, strict=True)
    comments: int = Field(default=0, ge=0, le=9_007_199_254_740_991, strict=True)
    subs_gained: int = Field(default=0, ge=0, le=9_007_199_254_740_991, strict=True)
    hook_used: Annotated[
        str,
        StringConstraints(strip_whitespace=True, max_length=2_000, pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$"),
    ] = ""
    notes: Annotated[
        str,
        StringConstraints(strip_whitespace=True, max_length=6_000, pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$"),
    ] = ""
    language: BoundedCreativeLanguage = "en-US"
    brand_voice: BoundedBrandVoice | None = None
    creator_profile: BoundedCreatorProfile | None = None

    @field_validator("retention_pct", mode="before")
    @classmethod
    def require_numeric_retention(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("retention_pct must be numeric")
        return value


class FeedbackResponse(BaseModel):
    """Response from /feedback — analysis of logged performance."""
    model_config = ConfigDict(extra="forbid")

    status: Literal["logged"]
    analysis: dict[str, object]                    # bounded by the validator below
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)

    @field_validator("analysis", mode="before")
    @classmethod
    def require_bounded_analysis(cls, value: object) -> dict[str, object]:
        if value == {}:
            return {}
        return FeedbackAnalysisPayload.model_validate(value).model_dump(exclude_none=True)


class ContentPublicationTrackingUnavailable(BaseModel):
    """Explicitly records that external publication observation is absent."""

    model_config = ConfigDict(extra="forbid")

    availability: Literal["unavailable"]
    reason_code: Literal["CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED"]
    publication_execution: Literal["not_supported"]


class ContentReportPayload(BaseModel):
    """Bounded report envelope over user-logged outcome records, not publications."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["available", "no_data", "unavailable", "analysis_unavailable"]
    degraded: bool = Field(strict=True)
    data_source_status: Literal["available", "unavailable"]
    reason_code: Literal[
        "internal_auth_unavailable",
        "invalid_backend_payload",
        "backend_request_rejected",
        "backend_unavailable",
        "provider_output_invalid",
    ] | None = None
    message: BoundedOutputDetail | None = None
    videos_published: None
    outcomes_logged: int | None = Field(ge=0, le=9_007_199_254_740_991, strict=True)
    publication_tracking: ContentPublicationTrackingUnavailable
    total_views: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991, strict=True)
    avg_retention: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    best_performer: BoundedOutputDetail | ReportPerformerPayload | None = None
    worst_performer: BoundedOutputDetail | ReportPerformerPayload | None = None
    top_insights: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    recommendations: list[BoundedOutputDetail] = Field(default_factory=list, max_length=20)
    hook_analysis: BoundedOutputDetail | None = None
    trend_direction: Literal["improving", "stable", "declining"] | None = None

    @field_validator("avg_retention", mode="before")
    @classmethod
    def require_numeric_average_retention(cls, value: object) -> object:
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError("avg_retention must be numeric")
        return value

    @model_validator(mode="after")
    def require_consistent_availability(self) -> "ContentReportPayload":
        if self.status == "unavailable":
            if self.data_source_status != "unavailable" or self.outcomes_logged is not None or not self.degraded:
                raise ValueError("unavailable reports must preserve unknown outcome state")
        elif self.data_source_status != "available":
            raise ValueError("available report states require an available data source")
        if self.status == "no_data" and self.outcomes_logged != 0:
            raise ValueError("no_data reports require zero logged outcomes")
        if self.status in {"available", "analysis_unavailable"} and (
            self.outcomes_logged is None or self.outcomes_logged <= 0
        ):
            raise ValueError("an analyzed report requires at least one logged outcome")
        return self


class ReportRequest(AttributionFields):
    """Request body for /report when called from an authenticated TS route."""
    user_id: int = Field(gt=0, le=9_007_199_254_740_991, strict=True)
    tenant_id: int = Field(gt=0, le=9_007_199_254_740_991, strict=True)
    internal_attribution_token: BoundedAttributionToken
    period: Literal["week", "month"] = "week"
    language: BoundedCreativeLanguage = "en-US"
    creator_profile: BoundedCreatorProfile | None = None


class ReportResponse(BaseModel):
    """Response from /report — weekly/monthly content report."""
    model_config = ConfigDict(extra="forbid")

    period: BoundedOutputText
    report: dict[str, object]                     # bounded by the validator below
    duration_ms: BoundedDurationMs
    degraded: bool = Field(default=False, strict=True)
    warnings: list[BoundedResponseWarning] = Field(default_factory=list, max_length=10)

    @field_validator("report", mode="before")
    @classmethod
    def require_bounded_report(cls, value: object) -> dict[str, object]:
        return ContentReportPayload.model_validate(value).model_dump(exclude_unset=True)
