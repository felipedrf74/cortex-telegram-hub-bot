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
from pydantic import BaseModel

from services.claude_client import ask_claude_json, MODEL
from services.creator_context import creator_profile_block, language_instruction
from services.creative.operation_prompt_compilers import OperationPromptInput, build_operation_metadata, compile_operation_prompt
from config import cfg

import httpx

logger = logging.getLogger("content-engine.books")

SERPAPI_URL = "https://serpapi.com/search.json"


class BookDNA(BaseModel):
    title: str
    author: str
    core_thesis: str
    key_frameworks: list[dict]   # [{name, description, use_in_content, pillar}]
    quotable_ideas: list[dict]   # [{idea, context, use_when}]
    pillar_mapping: list[str]    # which content pillars this book relates to
    counter_arguments: list[str]  # what opponents say
    related_thinkers: list[str]  # for cross-referencing
    personal_notes: list[str]    # initially empty


async def _web_search(query: str, max_results: int = 5) -> list[dict]:
    """Run a single SerpAPI search and return organic results."""
    if not cfg.serpapi_api_key:
        return []
    try:
        params = {
            "q": query,
            "api_key": cfg.serpapi_api_key,
            "num": max_results,
            "hl": "pt",
            "gl": "br",
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
        logger.warning("Web search failed for '%s': %s", query, e)
        return []


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

    search_tasks = [_web_search(q, max_results=3) for q in queries]
    results_lists = await asyncio.gather(*search_tasks, return_exceptions=True)

    # Flatten results
    all_results = []
    for results in results_lists:
        if isinstance(results, list):
            all_results.extend(results)

    # Build research context
    research_context = ""
    for i, r in enumerate(all_results[:20]):
        research_context += f"\n[{i+1}] {r['title']}\n{r['snippet']}\nSource: {r['link']}\n"

    if not research_context.strip():
        # No search results — return a low-confidence partial result instead
        # of asking the model to hallucinate book content.
        logger.warning("No web search results for '%s' by %s — returning partial result", title, author)
        duration_ms = int((time.monotonic() - start) * 1000)
        compiled = compile_operation_prompt(OperationPromptInput(
            operation="book_source",
            topic=f"{title} by {author}",
            language=language,
            creator_profile=creator_profile or "",
            source_summary=[],
            format_contract="No source data available; return low-confidence metadata only.",
        ))
        metadata = build_operation_metadata(_BookOperationRequest(), "book_source", compiled)
        metadata["quality_report"]["warnings"].append("no_source_data")
        return BookDNA(
            title=title,
            author=author,
            core_thesis=f"[LOW CONFIDENCE] No web search results found for '{title}' by {author}. "
                        "Re-run with SerpAPI configured or add personal notes manually.",
            key_frameworks=[],
            quotable_ideas=[],
            pillar_mapping=[],
            counter_arguments=[],
            related_thinkers=[],
            personal_notes=[f"⚠️ Extraction skipped — no research data available ({duration_ms}ms)"],
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
Focus on frameworks, provocative ideas, and counter-arguments that align with the supplied creator profile. If no creator profile is supplied, keep recommendations topic-driven and neutral.

Return ONLY valid JSON, no markdown wrapping."""

    schema = f"""Extract and return a JSON object with these exact fields:
{{
    "title": "{title}",
    "author": "{author}",
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
            "idea": "The provocative idea or quote",
            "context": "What the author meant",
            "use_when": "When the authenticated creator should reference this (e.g., 'when discussing minimum wage')"
        }}
    ],
    "pillar_mapping": ["topic category"],
    "counter_arguments": ["What critics say about this book — useful for reaction content"],
    "related_thinkers": ["Other thinkers who share or oppose these views"],
    "personal_notes": []
}}

Extract 3-6 key frameworks and 4-8 quotable ideas. Focus on what's USEFUL for the authenticated creator's content, not academic completeness.
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
    ))

    result = await ask_claude_json(
        compiled.prompt,
        system=system_prompt,
        model=MODEL,
        max_tokens=2800,
        temperature=0.5,
        category="content_engine_book",
    )

    duration_ms = int((time.monotonic() - start) * 1000)
    logger.info("Book extraction for '%s' completed in %dms", title, duration_ms)

    # Parse result into BookDNA
    if isinstance(result, dict) and "raw" not in result:
        return BookDNA(
            title=result.get("title", title),
            author=result.get("author", author),
            core_thesis=result.get("core_thesis", ""),
            key_frameworks=result.get("key_frameworks", []),
            quotable_ideas=result.get("quotable_ideas", []),
            pillar_mapping=result.get("pillar_mapping", []),
            counter_arguments=result.get("counter_arguments", []),
            related_thinkers=result.get("related_thinkers", []),
            personal_notes=result.get("personal_notes", []),
        ), build_operation_metadata(_BookOperationRequest(), "book_source", compiled)
    else:
        # Fallback — return minimal
        return BookDNA(
            title=title,
            author=author,
            core_thesis=str(result.get("raw", "Extraction failed")),
            key_frameworks=[],
            quotable_ideas=[],
            pillar_mapping=[],
            counter_arguments=[],
            related_thinkers=[],
            personal_notes=[],
        ), build_operation_metadata(_BookOperationRequest(), "book_source", compiled)
