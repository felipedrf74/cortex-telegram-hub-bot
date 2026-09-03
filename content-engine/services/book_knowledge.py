"""
Book Knowledge System — researches books via web search and extracts
structured knowledge for the intelligence bus.

Pipeline:
1. Receive book title + author
2. Run multi-query web search (5-8 queries)
3. Claude Sonnet synthesizes into structured BookDNA
4. Return structured payload
"""

import asyncio
import time
import logging
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from services.claude_client import ask_claude_json, MODEL
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt
from services.log_safety import input_fingerprint, safe_error_type
from config import cfg

import httpx

logger = logging.getLogger("content-engine.books")

SERPAPI_URL = "https://serpapi.com/search.json"


BoundedBookLine = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=500, pattern=r"^[^\x00-\x1f\x7f]+$"),
]
BoundedBookDetail = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=4_000,
        pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$",
    ),
]


class BookFramework(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: BoundedBookLine
    description: BoundedBookDetail
    use_in_content: BoundedBookDetail | None = None
    pillar: BoundedBookLine | None = None


class BookIdea(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idea: BoundedBookDetail
    context: BoundedBookDetail | None = None
    use_when: BoundedBookDetail | None = None


class BookDNA(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: BoundedBookLine
    author: BoundedBookLine
    core_thesis: BoundedBookDetail
    key_frameworks: list[BookFramework] = Field(default_factory=list, max_length=6)
    quotable_ideas: list[BookIdea] = Field(default_factory=list, max_length=8)
    pillar_mapping: list[BoundedBookLine] = Field(default_factory=list, max_length=20)
    counter_arguments: list[BoundedBookDetail] = Field(default_factory=list, max_length=20)
    related_thinkers: list[BoundedBookLine] = Field(default_factory=list, max_length=20)
    personal_notes: list[BoundedBookDetail] = Field(default_factory=list, max_length=20)


def _book_output_unavailable(language: str) -> str:
    locale = (language or "en-US").strip().lower()
    if locale == "pt-pt":
        return "A extração gerada ficou indisponível porque a resposta do fornecedor não cumpriu o contrato."
    if locale == "pt-br":
        return "A extração gerada ficou indisponível porque a resposta do provedor não cumpriu o contrato."
    return "Generated extraction is unavailable because the provider response did not match the contract."


def _book_no_source_copy(language: str, title: str, author: str, duration_ms: int) -> tuple[str, str]:
    locale = (language or "en-US").strip().lower()
    if locale == "pt-pt":
        return (
            f"[BAIXA CONFIANÇA] Não foram encontrados resultados de pesquisa para '{title}', de {author}. "
            "Volte a executar com o SerpAPI configurado ou adicione notas pessoais manualmente.",
            f"⚠️ Extração não executada — não existem dados de pesquisa ({duration_ms} ms)",
        )
    if locale == "pt-br":
        return (
            f"[BAIXA CONFIANÇA] Nenhum resultado de pesquisa foi encontrado para '{title}', de {author}. "
            "Execute novamente com o SerpAPI configurado ou adicione notas pessoais manualmente.",
            f"⚠️ Extração não executada — não há dados de pesquisa ({duration_ms} ms)",
        )
    return (
        f"[LOW CONFIDENCE] No web search results found for '{title}' by {author}. "
        "Re-run with SerpAPI configured or add personal notes manually.",
        f"⚠️ Extraction skipped — no research data available ({duration_ms}ms)",
    )


def _serpapi_locale(language: str | None) -> tuple[str, str]:
    normalized = (language or "en-US").strip().lower()
    if normalized == "pt-br" or "brazil" in normalized or "brasil" in normalized:
        return "pt", "br"
    if normalized == "pt-pt" or "portugal" in normalized or "european" in normalized:
        return "pt", "pt"
    if normalized.startswith("pt"):
        return "pt", "pt"
    return "en", "us"


async def _web_search(query: str, max_results: int = 5, language: str = "en-US") -> list[dict]:
    """Run a single SerpAPI search and return organic results."""
    if not cfg.serpapi_key:
        return []
    try:
        hl, gl = _serpapi_locale(language)
        params = {
            "q": query,
            "api_key": cfg.serpapi_key,
            "num": max_results,
            "hl": hl,
            "gl": gl,
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(SERPAPI_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
        return [
            {
                "title": r.get("title", ""),
                "snippet": r.get("snippet", ""),
                "link": r.get("link", ""),
            }
            for r in data.get("organic_results", [])[:max_results]
        ]
    except Exception as e:
        logger.warning(
            "Book web search failed (query_hash=%s query_len=%d error_type=%s)",
            input_fingerprint(query),
            len(query),
            safe_error_type(e),
        )
        # Preserve a categorical failure for the aggregate operation so a
        # partial eight-query result is never presented as fully healthy.
        # Neither upstream response bytes nor the private query cross this
        # boundary.
        raise RuntimeError("Book research source unavailable") from None


async def extract_book(
    title: str,
    author: str,
    creator_profile: str | None = None,
    language: str = "en-US",
) -> BookDNA:
    book, _metadata = await extract_book_with_metadata(title, author, creator_profile=creator_profile, language=language)
    return book


class _BookOperationRequest:
    source_package_id = None
    voice_card_version = None
    draft_id = None
    script_id = None
    reuse_policy = None
    quality_tier = "standard"

    def __init__(self, language: str):
        self.language = language


async def extract_book_with_metadata(
    title: str,
    author: str,
    creator_profile: str | None = None,
    language: str = "en-US",
) -> tuple[BookDNA, dict]:
    """Research a book via web search and extract structured knowledge."""
    start = time.monotonic()

    # Phase 1: Multi-query web search
    queries = [
        f'"{title}" {author} key concepts summary',
        f'"{title}" main arguments thesis core ideas',
        f'"{title}" chapter summary breakdown',
        f'"{title}" best quotes notable ideas',
        f'"{title}" {author} framework model methodology',
        f'"{title}" criticism counter-arguments critique',
        f'{author} philosophy core beliefs worldview',
        f'"{title}" practical application real world',
    ]

    search_tasks = [_web_search(q, max_results=3, language=language) for q in queries]
    results_lists = await asyncio.gather(*search_tasks, return_exceptions=True)

    # Flatten results
    all_results = []
    failed_query_count = 0
    for results in results_lists:
        if isinstance(results, list):
            all_results.extend(results)
        elif isinstance(results, Exception):
            failed_query_count += 1

    # Build research context
    research_context = ""
    for i, r in enumerate(all_results[:20]):
        research_context += f"\n[{i+1}] {r['title']}\n{r['snippet']}\nSource: {r['link']}\n"

    if not research_context.strip():
        # No search results — return a low-confidence partial result instead
        # of asking the model to hallucinate book content.
        logger.warning(
            "No book search results; returning partial result (input_hash=%s input_len=%d)",
            input_fingerprint(f"{title}\0{author}"),
            len(title) + len(author),
        )
        duration_ms = int((time.monotonic() - start) * 1000)
        compiled = compile_operation_prompt(OperationPromptInput(
            operation="book_source",
            topic=f"{title} by {author}",
            language=language,
            creator_profile=creator_profile or "",
            source_summary=[],
            format_contract="No source data available; return low-confidence metadata only.",
        ))
        metadata = build_operation_metadata(
            _BookOperationRequest(language),
            "book_source",
            compiled,
            duration_ms=duration_ms,
        )
        if failed_query_count:
            metadata["quality_report"]["warnings"].append("research_source_unavailable")
        metadata["quality_report"]["warnings"].append("no_source_data")
        core_thesis, extraction_note = _book_no_source_copy(language, title, author, duration_ms)
        return BookDNA(
            title=title,
            author=author,
            core_thesis=core_thesis,
            key_frameworks=[],
            quotable_ideas=[],
            pillar_mapping=[],
            counter_arguments=[],
            related_thinkers=[],
            personal_notes=[extraction_note],
        ), metadata

    # Phase 2: Claude Sonnet synthesis
    context = type("BookCreatorContext", (), {
        "creator_profile": creator_profile,
        "language": language,
    })()

    system_prompt = f"""You are an intellectual knowledge extractor for the authenticated content creator.

{creator_profile_block(context)}

{language_instruction(context)}

Your task: Extract structured knowledge from a book that the authenticated creator can use in their content.
Think through the supplied creator profile and saved brand voice — how would this creator use these ideas in videos for their saved target audience?
Focus on useful frameworks, notable ideas, and relevant caveats or counter-arguments that align with the supplied creator profile. If no creator profile is supplied, keep recommendations topic-driven and neutral.

Return ONLY valid JSON, no markdown wrapping."""

    schema = f"""Extract and return a JSON object with these exact fields:
{{
    "core_thesis": "2-3 sentences summarizing the book's main argument",
    "key_frameworks": [
        {{
            "name": "Framework name",
            "description": "What it is (2-3 sentences)",
            "use_in_content": "How the creator would use this in a video — specific example",
            "pillar": "Which supplied creator content pillar it maps to, or a neutral topic category if no pillar is supplied"
        }}
    ],
    "quotable_ideas": [
        {{
            "idea": "A notable or reusable idea from the supplied evidence",
            "context": "What the author meant",
            "use_when": "When this idea is relevant to the requested topic or supplied creator pillars"
        }}
    ],
    "pillar_mapping": ["topic category"],
    "counter_arguments": ["Relevant criticism, limitation, or counter-argument for balanced content"],
    "related_thinkers": ["Other thinkers who share or oppose these views"]
}}

Extract 3-6 key frameworks and 4-8 quotable ideas. Focus on what's USEFUL for the authenticated creator's content, not academic completeness.
Title, author, and personal notes are server-owned fields; do not emit them.
Do not assume any political, religious, dietary, national, or founder-specific angle unless the supplied creator profile asks for it."""
    compiled = compile_operation_prompt(OperationPromptInput(
        operation="book_source",
        topic=f"{title} by {author}",
        language=language,
        creator_profile=creator_profile_block(context),
        source_summary=[
            f"{r['title']} — {r['snippet']} Source: {r['link']}"
            for r in all_results[:16]
        ],
        format_contract=schema,
        system_prompt=system_prompt,
    ))

    result = await ask_claude_json(
        compiled.prompt,
        system=system_prompt,
        model=MODEL,
        max_tokens=compiled.output_token_budget or 2600,
        temperature=0.5,
        category="content_engine_book",
    )

    duration_ms = int((time.monotonic() - start) * 1000)
    logger.info(
        "Book extraction completed (input_hash=%s input_len=%d duration_ms=%d)",
        input_fingerprint(f"{title}\0{author}"),
        len(title) + len(author),
        duration_ms,
    )

    metadata = build_operation_metadata(
        _BookOperationRequest(language),
        "book_source",
        compiled,
        duration_ms=duration_ms,
    )
    if failed_query_count:
        metadata["quality_report"]["warnings"].append("research_source_unavailable")
    try:
        if not isinstance(result, dict) or "raw" in result:
            raise ValueError("provider_output_invalid")
        book = BookDNA.model_validate({
            "title": title,
            "author": author,
            "core_thesis": result.get("core_thesis"),
            "key_frameworks": result.get("key_frameworks", []),
            "quotable_ideas": result.get("quotable_ideas", []),
            "pillar_mapping": result.get("pillar_mapping", []),
            "counter_arguments": result.get("counter_arguments", []),
            "related_thinkers": result.get("related_thinkers", []),
            # Personal notes are first-party workspace data, never model output.
            "personal_notes": [],
        })
        return book, metadata
    except (TypeError, ValidationError, ValueError):
        logger.warning("Book provider output failed the bounded response contract")
        metadata["quality_report"]["warnings"].append("provider_output_invalid")
        return BookDNA(
            title=title,
            author=author,
            core_thesis=_book_output_unavailable(language),
        ), metadata
