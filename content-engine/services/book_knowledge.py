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
from services.creator_profile import get_profile
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


async def extract_book(title: str, author: str) -> BookDNA:
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
        )

    # Phase 2: Claude Sonnet synthesis
    profile = get_profile()

    system_prompt = f"""You are an intellectual knowledge extractor for the authenticated content creator.

{profile}

Your task: Extract structured knowledge from a book that the authenticated creator can use in his content.
Think through the creator's saved brand voice and worldview — how would HE use these ideas in videos for the creator's saved target audience?
Focus on frameworks, provocative ideas, and counter-arguments that align with his worldview.

Return ONLY valid JSON, no markdown wrapping."""

    prompt = f"""Research the book "{title}" by {author}.

WEB RESEARCH FINDINGS:
{research_context}

Extract and return a JSON object with these exact fields:
{{
    "title": "{title}",
    "author": "{author}",
    "core_thesis": "2-3 sentences summarizing the book's main argument",
    "key_frameworks": [
        {{
            "name": "Framework name",
            "description": "What it is (2-3 sentences)",
            "use_in_content": "How the creator would use this in a video — specific example",
            "pillar": "Which content pillar it maps to (politics/economics/fitness/faith/self-development/geopolitics)"
        }}
    ],
    "quotable_ideas": [
        {{
            "idea": "The provocative idea or quote",
            "context": "What the author meant",
            "use_when": "When the authenticated creator should reference this (e.g., 'when discussing minimum wage')"
        }}
    ],
    "pillar_mapping": ["economics", "politics"],
    "counter_arguments": ["What critics say about this book — useful for reaction content"],
    "related_thinkers": ["Other thinkers who share or oppose these views"],
    "personal_notes": []
}}

Extract 3-6 key frameworks and 4-8 quotable ideas. Focus on what's USEFUL for the authenticated creator's content, not academic completeness.
For Austrian economics books, extract the most provocative anti-state arguments.
For philosophy/faith books, extract frameworks that challenge mainstream thinking."""

    result = await ask_claude_json(
        prompt,
        system=system_prompt,
        model=MODEL,
        max_tokens=6000,
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
        )
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
        )
