"""
Book Knowledge API — extract, store, and query book knowledge.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from models.requests import (
    AttributionFields,
    BoundedCreativeLanguage,
    BoundedCreatorProfile,
    BoundedDurationMs,
    BoundedOutputText,
    ContentOperationMetadata,
)
from services.book_knowledge import BookDNA, extract_book_with_metadata
from services.claude_client import reset_attribution_context, set_attribution_context
from services.creative.operation_prompt_compilers import classify_operation_topic
from routers.request_cancellation import run_until_client_disconnect

router = APIRouter(prefix="/api/v1", tags=["books"])


class BookExtractRequest(AttributionFields):
    title: BoundedOutputText
    author: BoundedOutputText
    language: BoundedCreativeLanguage = "en-US"
    creator_profile: BoundedCreatorProfile | None = None


class BookExtractResponse(ContentOperationMetadata):
    book: BookDNA
    duration_ms: BoundedDurationMs


class BookNoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: BoundedOutputText
    note: BoundedCreatorProfile


@router.post("/books/extract", response_model=BookExtractResponse)
async def extract_book_endpoint(req: BookExtractRequest, request: Request):
    """Research a book via web search and extract structured knowledge."""
    # 2026-05-18 phase2-qa P1: gate book extraction (8 SerpAPI queries + Sonnet
    # @ max_tokens=2800, the most expensive Phase 2 operation) BEFORE the AI
    # call. Without this guard an unsupported/high-risk book title routed
    # straight into a $0.10+ Sonnet call with no safety filter.
    topic = f"{req.title} {req.author}".strip()
    decision = classify_operation_topic(topic)
    if decision["route"] == "unsupported":
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_UNSUPPORTED_TOPIC",
                    "message": "This book request cannot be analyzed safely.",
                    "details": {"operation": "book_source", "researchRoute": decision},
                }
            },
        )
    if decision["route"] == "high_risk_review":
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "CONTENT_HIGH_RISK_REVIEW_REQUIRED",
                    "message": "This topic requires sourced review before book analysis.",
                    "details": {"operation": "book_source", "researchRoute": decision},
                }
            },
        )

    import time
    start = time.monotonic()
    token = set_attribution_context(
        user_id=req.user_id,
        tenant_id=req.tenant_id,
        attribution_token=req.internal_attribution_token,
        inference_attribution_token=req.internal_inference_attribution_token,
        inference_proof_key=req.internal_inference_proof_key,
    )
    try:
        book, metadata = await run_until_client_disconnect(
            request,
            lambda: extract_book_with_metadata(
                req.title,
                req.author,
                creator_profile=req.creator_profile,
                language=req.language,
            ),
        )
    finally:
        reset_attribution_context(token)
    duration_ms = int((time.monotonic() - start) * 1000)
    return BookExtractResponse(book=book, duration_ms=duration_ms, **metadata)
