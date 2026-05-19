"""
Book Knowledge API — extract, store, and query book knowledge.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from models.requests import AttributionFields, ContentOperationMetadata
from services.book_knowledge import BookDNA, extract_book_with_metadata
from services.claude_client import reset_attribution_context, set_attribution_context
from services.creative.operation_prompt_compilers import classify_operation_topic

router = APIRouter(prefix="/api/v1", tags=["books"])


class BookExtractRequest(AttributionFields):
    title: str = Field(min_length=1)
    author: str = Field(min_length=1)
    language: str = Field(default="en-US")
    creator_profile: str | None = Field(default=None)


class BookExtractResponse(ContentOperationMetadata):
    book: BookDNA
    duration_ms: int


class BookNoteRequest(BaseModel):
    title: str = Field(min_length=1)
    note: str = Field(min_length=1)


@router.post("/books/extract", response_model=BookExtractResponse)
async def extract_book_endpoint(req: BookExtractRequest):
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
    )
    try:
        book, metadata = await extract_book_with_metadata(
            req.title,
            req.author,
            creator_profile=req.creator_profile,
            language=req.language,
        )
    finally:
        reset_attribution_context(token)
    duration_ms = int((time.monotonic() - start) * 1000)
    return BookExtractResponse(book=book, duration_ms=duration_ms, **metadata)
