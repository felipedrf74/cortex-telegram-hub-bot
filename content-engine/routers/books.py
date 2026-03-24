"""
Book Knowledge API — extract, store, and query book knowledge.
"""

from fastapi import APIRouter
from pydantic import BaseModel, Field
from services.book_knowledge import extract_book, BookDNA

router = APIRouter(prefix="/api/v1", tags=["books"])


class BookExtractRequest(BaseModel):
    title: str = Field(min_length=1)
    author: str = Field(min_length=1)


class BookExtractResponse(BaseModel):
    book: BookDNA
    duration_ms: int


class BookNoteRequest(BaseModel):
    title: str = Field(min_length=1)
    note: str = Field(min_length=1)


@router.post("/books/extract", response_model=BookExtractResponse)
async def extract_book_endpoint(req: BookExtractRequest):
    """Research a book via web search and extract structured knowledge."""
    import time
    start = time.monotonic()
    book = await extract_book(req.title, req.author)
    duration_ms = int((time.monotonic() - start) * 1000)
    return BookExtractResponse(book=book, duration_ms=duration_ms)
