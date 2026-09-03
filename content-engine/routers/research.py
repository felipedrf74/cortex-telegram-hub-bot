from fastapi import APIRouter, Depends, HTTPException, Query, Request
from models.requests import (
    DeepSearchRequest, DeepSearchResponse, SourcesResponse, HotNewsRequest, HotNewsResponse,
    TrendingResponse, ReactionResponse,
    HooksRequest, HooksResponse,
    ScriptRequest, ScriptResponse,
    TitlesRequest, TitlesResponse,
    ThumbnailRequest, ThumbnailResponse,
    CaptionRequest, CaptionResponse,
    CompetitorRequest, CompetitorResponse,
    GapsRequest, GapsResponse,
    SeoRequest, SeoResponse,
    RepurposeRequest, RepurposeResponse,
    FeedbackRequest, FeedbackResponse,
    ReportRequest,
    ReportResponse,
    BoundedCreativeNiche,
    BoundedCreativeTopic,
    BoundedCreativeLanguage,
)
from services.orchestrator import ResearchOrchestrator
from services.claude_client import set_attribution_context, reset_attribution_context
from services.creative.operation_prompt_compilers import classify_operation_topic
from routers.request_cancellation import run_until_client_disconnect as _run_until_client_disconnect

router = APIRouter(prefix="/api/v1", tags=["research"])

# Singleton orchestrator — reused across requests
_orchestrator: ResearchOrchestrator | None = None


def get_orchestrator() -> ResearchOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = ResearchOrchestrator()
    return _orchestrator


def _require_bounded_query_text(value: str, field_name: str) -> str:
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > 2_000
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        raise HTTPException(status_code=422, detail=f"{field_name} must be bounded non-control text")
    return normalized


async def _with_ai_attribution(req, operation, client_request: Request | None = None):
    token = set_attribution_context(
        user_id=getattr(req, "user_id", None),
        tenant_id=getattr(req, "tenant_id", None),
        attribution_token=getattr(req, "internal_attribution_token", None),
        inference_attribution_token=getattr(req, "internal_inference_attribution_token", None),
        inference_proof_key=getattr(req, "internal_inference_proof_key", None),
    )
    try:
        if client_request is not None:
            return await _run_until_client_disconnect(client_request, operation)
        return await operation()
    finally:
        reset_attribution_context(token)


def _creative_topic_guard(topic: str, operation: str) -> None:
    decision = classify_operation_topic(topic)
    if decision["route"] == "unsupported":
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_UNSUPPORTED_TOPIC",
                    "message": "This content request cannot be generated safely.",
                    "details": {"operation": operation, "researchRoute": decision},
                }
            },
        )
    if decision["route"] == "high_risk_review":
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_HIGH_RISK_REVIEW_REQUIRED",
                    "message": "This topic requires sourced review before creative generation.",
                    "details": {"operation": operation, "researchRoute": decision},
                }
            },
        )


def _creative_request_guard(operation: str, req, *semantic_inputs: str) -> None:
    """Apply safety precedence before checking timely grounding requirements."""
    source_summary = getattr(req, "source_summary", None) or []
    source_package_id = getattr(req, "source_package_id", None)
    has_scoped_attribution = (
        isinstance(getattr(req, "user_id", None), int)
        and not isinstance(getattr(req, "user_id", None), bool)
        and getattr(req, "user_id", 0) > 0
        and isinstance(getattr(req, "tenant_id", None), int)
        and not isinstance(getattr(req, "tenant_id", None), bool)
        and getattr(req, "tenant_id", 0) > 0
        and bool(getattr(req, "internal_attribution_token", None))
    )
    decisions = [
        classify_operation_topic(value)
        for value in semantic_inputs
        if value
    ]
    normalized_semantics = [" ".join(value.split()) for value in semantic_inputs if value]
    if len(normalized_semantics) > 1:
        combined = classify_operation_topic(" ".join(normalized_semantics))
        if combined["route"] in {"unsupported", "high_risk_review"}:
            decisions.append(combined)
    unsupported = next((decision for decision in decisions if decision["route"] == "unsupported"), None)
    high_risk = next((decision for decision in decisions if decision["route"] == "high_risk_review"), None)
    fresh = next((decision for decision in decisions if decision["route"] == "fresh_compact"), None)
    if unsupported:
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_UNSUPPORTED_TOPIC",
                    "message": "This content request cannot be generated safely.",
                    "details": {"operation": operation, "researchRoute": unsupported},
                }
            },
        )
    if high_risk:
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_HIGH_RISK_REVIEW_REQUIRED",
                    "message": "This high-risk topic requires human source review before any creative generation.",
                    "details": {"operation": operation, "researchRoute": high_risk},
                }
            },
        )
    if fresh and (
        not has_scoped_attribution
        or not source_package_id
        or not source_summary
    ):
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_RESEARCH_REQUIRED",
                    "message": "This timely topic requires scoped attribution and a grounded source package before creative generation.",
                    "details": {"operation": operation, "researchRoute": fresh},
                }
            },
        )


def _script_topic_guard(req: ScriptRequest) -> None:
    """Block unsupported and high-risk scripts before research or generation."""
    context = req.topic_context
    semantic_values = [
        value
        for value in (
            req.topic,
            req.niche,
            req.research_query or "",
            context.niche if context else None,
            context.hook_idea if context else None,
            context.why_now if context else None,
            context.angle_tag if context else None,
            context.source_job if context else None,
        )
        if value
    ]
    decisions = [
        classify_operation_topic(value)
        for value in semantic_values
    ]
    if len(semantic_values) > 1:
        decisions.append(classify_operation_topic(" ".join(" ".join(value.split()) for value in semantic_values)))
    unsupported = next((decision for decision in decisions if decision["route"] == "unsupported"), None)
    high_risk = next((decision for decision in decisions if decision["route"] == "high_risk_review"), None)
    if unsupported:
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_UNSUPPORTED_TOPIC",
                    "message": "This content request cannot be generated safely.",
                    "details": {"operation": "script", "researchRoute": unsupported},
                }
            },
        )
    if high_risk:
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_HIGH_RISK_REVIEW_REQUIRED",
                    "message": "This high-risk topic requires human source review before script generation.",
                    "details": {"operation": "script", "researchRoute": high_risk},
                }
            },
        )


def _validate_script_research_query(req: ScriptRequest) -> None:
    """Map safe canonical-subject contract failures to a stable client 422."""
    from services.creative import script_writer

    try:
        script_writer._script_research_subject(req)
    except script_writer.InvalidScriptResearchQueryError as error:
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_RESEARCH_QUERY_INVALID",
                    "message": "The script research subject does not match the canonical Topic/Niche boundary.",
                    "details": {"operation": "script", "reason": str(error)},
                }
            },
        ) from None


# ── Phase 1: Research Core ────────────────────────────────────────

@router.post("/deepsearch", response_model=DeepSearchResponse)
async def deep_search(
    req: DeepSearchRequest,
    request: Request,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> DeepSearchResponse:
    """Full research pipeline: parallel search → score → content briefs."""
    return await _with_ai_attribution(
        req,
        lambda: orch.deep_search(
            query=req.query,
            niches=req.niches if req.niches else None,
            max_results=req.max_results,
            creator_profile=req.creator_profile,
            language=req.language,
        ),
        client_request=request,
    )


@router.get("/sources", response_model=SourcesResponse)
async def get_sources(
    request: Request,
    query: BoundedCreativeTopic = Query(...),
    language: BoundedCreativeLanguage = Query(default="en-US"),
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> SourcesResponse:
    """Curated source list for a topic."""
    query = _require_bounded_query_text(query, "query")
    return await _run_until_client_disconnect(
        request,
        lambda: orch.get_sources(query, language=language),
    )


@router.post("/hotnews", response_model=HotNewsResponse)
async def hot_news_with_context(
    req: HotNewsRequest,
    request: Request,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> HotNewsResponse:
    """What's trending right now, scoped to the authenticated creator context."""
    return await _with_ai_attribution(
        req,
        lambda: orch.hot_news(creator_profile=req.creator_profile, language=req.language),
        client_request=request,
    )


# ── Phase 2: Visual + Social ─────────────────────────────────────

@router.get("/trending", response_model=TrendingResponse)
async def trending(
    request: Request,
    niche: BoundedCreativeNiche | None = Query(default=None),
    language: BoundedCreativeLanguage = Query(default="en-US"),
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> TrendingResponse:
    """Cross-platform trending topics. Optional niche filter."""
    if niche is not None:
        niche = _require_bounded_query_text(niche, "niche")
    return await _run_until_client_disconnect(
        request,
        lambda: orch.trending(niche=niche, language=language),
    )


@router.get("/reaction", response_model=ReactionResponse)
async def reaction_search(
    request: Request,
    topic: BoundedCreativeTopic = Query(...),
    language: BoundedCreativeLanguage = Query(default="en-US"),
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> ReactionResponse:
    """Find reaction-worthy content for a topic."""
    topic = _require_bounded_query_text(topic, "topic")
    return await _run_until_client_disconnect(
        request,
        lambda: orch.reaction_search(topic, language=language),
    )


# ── Phase 3: Creative Intelligence ───────────────────────────────

@router.post("/hooks", response_model=HooksResponse)
async def generate_hooks(req: HooksRequest, request: Request) -> HooksResponse:
    """Generate bounded, topic-specific opening variants for review."""
    from services.creative import hook_generator
    _creative_request_guard("hook_pack", req, req.topic, req.niche)
    return await _with_ai_attribution(
        req,
        lambda: hook_generator.generate(req),
        client_request=request,
    )


@router.post("/script", response_model=ScriptResponse)
async def generate_script(
    req: ScriptRequest,
    request: Request,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> ScriptResponse:
    """Generate a full video script with research baked in."""
    from services.creative import script_writer
    _script_topic_guard(req)
    _validate_script_research_query(req)
    return await _with_ai_attribution(
        req,
        lambda: script_writer.generate(req, orch),
        client_request=request,
    )


@router.post("/titles", response_model=TitlesResponse)
async def generate_titles(req: TitlesRequest, request: Request) -> TitlesResponse:
    """Generate A/B title variants for a topic."""
    from services.creative import title_tester
    _creative_request_guard("title_pack", req, req.topic, req.niche)
    return await _with_ai_attribution(
        req,
        lambda: title_tester.generate(req),
        client_request=request,
    )


@router.post("/thumbnail", response_model=ThumbnailResponse)
async def generate_thumbnail(req: ThumbnailRequest, request: Request) -> ThumbnailResponse:
    """Generate thumbnail concepts with visual direction."""
    from services.creative import thumbnail_gen
    _creative_request_guard("thumbnail_pack", req, req.title, req.topic, req.niche)
    return await _with_ai_attribution(
        req,
        lambda: thumbnail_gen.generate(req),
        client_request=request,
    )


@router.post("/caption", response_model=CaptionResponse)
async def generate_caption(req: CaptionRequest, request: Request) -> CaptionResponse:
    """Generate Instagram caption + optimised hashtags."""
    from services.creative import caption_writer
    _creative_request_guard("caption_pack", req, req.topic, req.niche)
    return await _with_ai_attribution(
        req,
        lambda: caption_writer.generate(req),
        client_request=request,
    )


# ── Phase 4: Strategic Intelligence ──────────────────────────────

@router.post("/competitor", response_model=CompetitorResponse)
async def analyze_competitor(req: CompetitorRequest, request: Request) -> CompetitorResponse:
    """Reverse-engineer a competitor channel."""
    from services.intelligence import competitor_analyzer
    _creative_topic_guard(req.channel, "competitor_insight")
    return await _with_ai_attribution(
        req,
        lambda: competitor_analyzer.analyze(req),
        client_request=request,
    )


@router.post("/gaps", response_model=GapsResponse)
async def find_gaps(
    req: GapsRequest,
    request: Request,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> GapsResponse:
    """Find content gaps — high demand, low supply."""
    from services.intelligence import gap_finder
    _creative_topic_guard(req.niche, "gap_insight")
    return await _with_ai_attribution(
        req,
        lambda: gap_finder.find(req, orch),
        client_request=request,
    )


@router.post("/seo", response_model=SeoResponse)
async def seo_analysis(
    req: SeoRequest,
    request: Request,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> SeoResponse:
    """Keyword analysis + content recommendations."""
    from services.intelligence import seo_engine
    _creative_topic_guard(req.topic, "seo_insight")
    return await _with_ai_attribution(
        req,
        lambda: seo_engine.analyze(req, orch),
        client_request=request,
    )


@router.post("/repurpose", response_model=RepurposeResponse)
async def repurpose(req: RepurposeRequest, request: Request) -> RepurposeResponse:
    """Generate one to ten bounded derivatives from a source item."""
    from services.creative import repurpose_engine
    _creative_request_guard("repurpose", req, req.topic, req.niche, req.source_content)
    return await _with_ai_attribution(
        req,
        lambda: repurpose_engine.generate(req),
        client_request=request,
    )


# ── Phase 5: Learning System ─────────────────────────────────────

@router.post("/feedback", response_model=FeedbackResponse)
async def log_feedback(req: FeedbackRequest, request: Request) -> FeedbackResponse:
    """Log content performance and get analysis."""
    from services.learning import feedback_loop
    return await _with_ai_attribution(
        req,
        lambda: feedback_loop.log_and_analyze(req),
        client_request=request,
    )


@router.post("/report", response_model=ReportResponse)
async def weekly_report_with_context(req: ReportRequest, request: Request) -> ReportResponse:
    """Weekly or monthly content performance report with signed request attribution."""
    from services.learning import report_gen
    return await _with_ai_attribution(
        req,
        lambda: report_gen.generate(
            req.period,
            creator_profile=req.creator_profile,
            language=req.language,
            tenant_id=req.tenant_id,
            attribution_token=req.internal_attribution_token,
        ),
        client_request=request,
    )
