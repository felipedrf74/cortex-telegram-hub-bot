import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from types import SimpleNamespace
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
)
from services.orchestrator import ResearchOrchestrator
from services.claude_client import set_attribution_context, reset_attribution_context
from services.creative.operation_prompt_compilers import classify_operation_topic

router = APIRouter(prefix="/api/v1", tags=["research"])

# Singleton orchestrator — reused across requests
_orchestrator: ResearchOrchestrator | None = None


def get_orchestrator() -> ResearchOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = ResearchOrchestrator()
    return _orchestrator


async def _run_until_client_disconnect(request: Request, operation):
    operation_task = asyncio.create_task(operation())

    async def wait_for_disconnect():
        while not await request.is_disconnected():
            await asyncio.sleep(0.05)

    disconnect_task = asyncio.create_task(wait_for_disconnect())
    try:
        done, _ = await asyncio.wait(
            {operation_task, disconnect_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if operation_task in done:
            return await operation_task
        operation_task.cancel()
        try:
            await operation_task
        except asyncio.CancelledError:
            pass
        raise asyncio.CancelledError("content_engine_client_disconnected")
    finally:
        for task in (operation_task, disconnect_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(operation_task, disconnect_task, return_exceptions=True)


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


# ── Phase 1: Research Core ────────────────────────────────────────

@router.post("/deepsearch", response_model=DeepSearchResponse)
async def deep_search(
    req: DeepSearchRequest,
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
    )


@router.get("/sources", response_model=SourcesResponse)
async def get_sources(
    query: str = Query(..., min_length=1),
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> SourcesResponse:
    """Curated source list for a topic."""
    return await orch.get_sources(query)


@router.get("/hotnews", response_model=HotNewsResponse)
async def hot_news(
    creator_profile: str | None = Query(default=None),
    language: str = Query(default="en-US"),
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> HotNewsResponse:
    """What's trending right now across all niches."""
    return await _with_ai_attribution(
        SimpleNamespace(user_id=None, tenant_id=None, internal_attribution_token=None),
        lambda: orch.hot_news(creator_profile=creator_profile, language=language),
    )


@router.post("/hotnews", response_model=HotNewsResponse)
async def hot_news_with_context(
    req: HotNewsRequest,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> HotNewsResponse:
    """What's trending right now, scoped to the authenticated creator context."""
    return await _with_ai_attribution(
        req,
        lambda: orch.hot_news(creator_profile=req.creator_profile, language=req.language),
    )


# ── Phase 2: Visual + Social ─────────────────────────────────────

@router.get("/trending", response_model=TrendingResponse)
async def trending(
    niche: str = Query(default=None),
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> TrendingResponse:
    """Cross-platform trending topics. Optional niche filter."""
    return await orch.trending(niche=niche)


@router.get("/reaction", response_model=ReactionResponse)
async def reaction_search(
    topic: str = Query(..., min_length=1),
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> ReactionResponse:
    """Find reaction-worthy content for a topic."""
    return await orch.reaction_search(topic)


# ── Phase 3: Creative Intelligence ───────────────────────────────

@router.post("/hooks", response_model=HooksResponse)
async def generate_hooks(req: HooksRequest) -> HooksResponse:
    """Generate scroll-stopping hooks for a topic."""
    from services.creative import hook_generator
    _creative_topic_guard(req.topic, "hook_pack")
    return await _with_ai_attribution(req, lambda: hook_generator.generate(req))


@router.post("/script", response_model=ScriptResponse)
async def generate_script(
    req: ScriptRequest,
    request: Request,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> ScriptResponse:
    """Generate a full video script with research baked in."""
    from services.creative import script_writer
    _creative_topic_guard(req.topic, "script")
    return await _with_ai_attribution(
        req,
        lambda: script_writer.generate(req, orch),
        client_request=request,
    )


@router.post("/titles", response_model=TitlesResponse)
async def generate_titles(req: TitlesRequest) -> TitlesResponse:
    """Generate A/B title variants for a topic."""
    from services.creative import title_tester
    _creative_topic_guard(req.topic, "title_pack")
    return await _with_ai_attribution(req, lambda: title_tester.generate(req))


@router.post("/thumbnail", response_model=ThumbnailResponse)
async def generate_thumbnail(req: ThumbnailRequest) -> ThumbnailResponse:
    """Generate thumbnail concepts with visual direction."""
    from services.creative import thumbnail_gen
    _creative_topic_guard(req.topic or req.title, "thumbnail_pack")
    return await _with_ai_attribution(req, lambda: thumbnail_gen.generate(req))


@router.post("/caption", response_model=CaptionResponse)
async def generate_caption(req: CaptionRequest) -> CaptionResponse:
    """Generate Instagram caption + optimised hashtags."""
    from services.creative import caption_writer
    _creative_topic_guard(req.topic, "caption_pack")
    return await _with_ai_attribution(req, lambda: caption_writer.generate(req))


# ── Phase 4: Strategic Intelligence ──────────────────────────────

@router.post("/competitor", response_model=CompetitorResponse)
async def analyze_competitor(req: CompetitorRequest) -> CompetitorResponse:
    """Reverse-engineer a competitor channel."""
    from services.intelligence import competitor_analyzer
    _creative_topic_guard(req.channel, "competitor_insight")
    return await _with_ai_attribution(req, lambda: competitor_analyzer.analyze(req))


@router.post("/gaps", response_model=GapsResponse)
async def find_gaps(
    req: GapsRequest,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> GapsResponse:
    """Find content gaps — high demand, low supply."""
    from services.intelligence import gap_finder
    _creative_topic_guard(req.niche, "gap_insight")
    return await _with_ai_attribution(req, lambda: gap_finder.find(req, orch))


@router.post("/seo", response_model=SeoResponse)
async def seo_analysis(
    req: SeoRequest,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> SeoResponse:
    """Keyword analysis + content recommendations."""
    from services.intelligence import seo_engine
    _creative_topic_guard(req.topic, "seo_insight")
    return await _with_ai_attribution(req, lambda: seo_engine.analyze(req, orch))


@router.post("/repurpose", response_model=RepurposeResponse)
async def repurpose(req: RepurposeRequest) -> RepurposeResponse:
    """Turn 1 content piece into a full content ecosystem."""
    from services.creative import repurpose_engine
    _creative_topic_guard(req.topic, "repurpose")
    return await _with_ai_attribution(req, lambda: repurpose_engine.generate(req))


# ── Phase 5: Learning System ─────────────────────────────────────

@router.post("/feedback", response_model=FeedbackResponse)
async def log_feedback(req: FeedbackRequest) -> FeedbackResponse:
    """Log content performance and get analysis."""
    from services.learning import feedback_loop
    return await _with_ai_attribution(req, lambda: feedback_loop.log_and_analyze(req))


@router.get("/report", response_model=ReportResponse)
async def weekly_report(
    period: str = Query(default="week"),
    creator_profile: str | None = Query(default=None),
    language: str = Query(default="en-US"),
) -> ReportResponse:
    """Weekly or monthly content performance report."""
    from services.learning import report_gen
    return await _with_ai_attribution(
        SimpleNamespace(user_id=None, tenant_id=None, internal_attribution_token=None),
        lambda: report_gen.generate(period, creator_profile=creator_profile, language=language),
    )


@router.post("/report", response_model=ReportResponse)
async def weekly_report_with_context(req: ReportRequest) -> ReportResponse:
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
    )
