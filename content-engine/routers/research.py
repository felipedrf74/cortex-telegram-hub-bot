from fastapi import APIRouter, Depends, Query
from models.requests import (
    DeepSearchRequest, DeepSearchResponse, SourcesResponse, HotNewsResponse,
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
    ReportResponse,
)
from services.orchestrator import ResearchOrchestrator

router = APIRouter(prefix="/api/v1", tags=["research"])

# Singleton orchestrator — reused across requests
_orchestrator: ResearchOrchestrator | None = None


def get_orchestrator() -> ResearchOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = ResearchOrchestrator()
    return _orchestrator


# ── Phase 1: Research Core ────────────────────────────────────────

@router.post("/deepsearch", response_model=DeepSearchResponse)
async def deep_search(
    req: DeepSearchRequest,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> DeepSearchResponse:
    """Full research pipeline: parallel search → score → content briefs."""
    return await orch.deep_search(
        query=req.query,
        niches=req.niches if req.niches else None,
        max_results=req.max_results,
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
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> HotNewsResponse:
    """What's trending right now across all niches."""
    return await orch.hot_news()


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
    return await hook_generator.generate(req)


@router.post("/script", response_model=ScriptResponse)
async def generate_script(
    req: ScriptRequest,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> ScriptResponse:
    """Generate a full video script with research baked in."""
    from services.creative import script_writer
    return await script_writer.generate(req, orch)


@router.post("/titles", response_model=TitlesResponse)
async def generate_titles(req: TitlesRequest) -> TitlesResponse:
    """Generate A/B title variants for a topic."""
    from services.creative import title_tester
    return await title_tester.generate(req)


@router.post("/thumbnail", response_model=ThumbnailResponse)
async def generate_thumbnail(req: ThumbnailRequest) -> ThumbnailResponse:
    """Generate thumbnail concepts with visual direction."""
    from services.creative import thumbnail_gen
    return await thumbnail_gen.generate(req)


@router.post("/caption", response_model=CaptionResponse)
async def generate_caption(req: CaptionRequest) -> CaptionResponse:
    """Generate Instagram caption + optimised hashtags."""
    from services.creative import caption_writer
    return await caption_writer.generate(req)


# ── Phase 4: Strategic Intelligence ──────────────────────────────

@router.post("/competitor", response_model=CompetitorResponse)
async def analyze_competitor(req: CompetitorRequest) -> CompetitorResponse:
    """Reverse-engineer a competitor channel."""
    from services.intelligence import competitor_analyzer
    return await competitor_analyzer.analyze(req)


@router.post("/gaps", response_model=GapsResponse)
async def find_gaps(
    req: GapsRequest,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> GapsResponse:
    """Find content gaps — high demand, low supply."""
    from services.intelligence import gap_finder
    return await gap_finder.find(req, orch)


@router.post("/seo", response_model=SeoResponse)
async def seo_analysis(
    req: SeoRequest,
    orch: ResearchOrchestrator = Depends(get_orchestrator),
) -> SeoResponse:
    """Keyword analysis + content recommendations."""
    from services.intelligence import seo_engine
    return await seo_engine.analyze(req, orch)


@router.post("/repurpose", response_model=RepurposeResponse)
async def repurpose(req: RepurposeRequest) -> RepurposeResponse:
    """Turn 1 content piece into a full content ecosystem."""
    from services.creative import repurpose_engine
    return await repurpose_engine.generate(req)


# ── Phase 5: Learning System ─────────────────────────────────────

@router.post("/feedback", response_model=FeedbackResponse)
async def log_feedback(req: FeedbackRequest) -> FeedbackResponse:
    """Log content performance and get analysis."""
    from services.learning import feedback_loop
    return await feedback_loop.log_and_analyze(req)


@router.get("/report", response_model=ReportResponse)
async def weekly_report(
    period: str = Query(default="week"),
) -> ReportResponse:
    """Weekly or monthly content performance report."""
    from services.learning import report_gen
    return await report_gen.generate(period)
