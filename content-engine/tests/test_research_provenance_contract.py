from models.requests import SourcesResponse
from models.research import SourceReference
from models.research import SearchResult
from models.scoring import ScoredResult, ScoreBreakdown
from services.orchestrator import _provenance_warnings, _source_mode


def test_research_source_mode_marks_real_mock_and_none_sources():
    real = [SourceReference(
        title="Creator research",
        url="https://news.example.org/creator-research",
        source_type="news",
        relevance_note="Useful source",
    )]
    mock = [SourceReference(
        title="[Mock] Creator research",
        url="https://example.com/mock",
        source_type="web",
        relevance_note="fixture mock",
    )]

    assert _source_mode(real) == "real"
    assert _source_mode(mock) == "mock"
    assert _source_mode([]) == "none"
    assert _source_mode([SourceReference(
        title="Transcript without public source",
        url="",
        source_type="transcript",
        relevance_note="User supplied transcript",
    )]) == "none"
    assert _source_mode(real, degraded=True) == "degraded"
    assert _provenance_warnings(mock) == ["mock_research_sources_non_publishable"]
    assert _provenance_warnings([]) == ["research_sources_missing_review_required"]


def test_source_mode_reads_mock_metadata_before_and_after_flattening():
    scored = ScoredResult(
        result=SearchResult(
            title="Creator research fixture",
            url="https://news.example.org/creator-research",
            source="news",
            metadata={"mock": True},
        ),
        score=ScoreBreakdown(composite=0.9),
    )
    flattened = {
        "title": "Creator research fixture",
        "original_title": "[Mock] Creator research fixture",
        "url": "https://news.example.org/creator-research",
        "metadata": {"mock": True},
    }

    assert _source_mode([scored]) == "mock"
    assert _source_mode([flattened]) == "mock"


def test_source_mode_does_not_treat_mock_substrings_in_real_domains_as_fixture():
    real = [SourceReference(
        title="Mockingbird product research",
        url="https://mockingbird.com/research/report",
        source_type="news",
        relevance_note="Real publisher whose domain contains the mock substring",
    )]
    explicit_mock_path = [SourceReference(
        title="Fixture source",
        url="https://publisher.example/research/mock/source",
        source_type="web",
        relevance_note="Explicit fixture path segment",
    )]
    exact_example_org = [SourceReference(
        title="Exact example host",
        url="https://example.org/research/report",
        source_type="web",
        relevance_note="Exact reserved example host",
    )]
    reddit_mock_segment = [SourceReference(
        title="Reddit mock segment",
        url="https://reddit.com/r/mock/comments/1",
        source_type="web",
        relevance_note="Explicit mock path segment",
    )]
    query_mock = [SourceReference(
        title="Query mock marker",
        url="https://publisher.example/research?mock=1",
        source_type="web",
        relevance_note="Explicit query mock marker",
    )]
    duplicate_query_mock = [SourceReference(
        title="Duplicate query mock marker",
        url="https://publisher.example/research?mock=0&mock=1",
        source_type="web",
        relevance_note="Explicit query mock marker",
    )]
    ftp_reserved_host = [SourceReference(
        title="Unsupported scheme reserved host",
        url="ftp://example.org/research/report",
        source_type="web",
        relevance_note="Reserved example host over ftp must not mark mock",
    )]

    assert _source_mode(real) == "real"
    assert _source_mode(explicit_mock_path) == "mock"
    assert _source_mode(exact_example_org) == "mock"
    assert _source_mode(reddit_mock_segment) == "mock"
    assert _source_mode(query_mock) == "mock"
    assert _source_mode(duplicate_query_mock) == "mock"
    assert _source_mode(ftp_reserved_host) == "none"


def test_source_mode_detects_anchored_mock_relevance_notes_without_mock_exam_false_positive():
    note_only_mock_sources = [
        SourceReference(
            title="Creator research",
            url="https://publisher.example/research/report",
            source_type="news",
            relevance_note="[mock] source for deterministic local testing",
        ),
        SourceReference(
            title="Creator research",
            url="https://publisher.example/research/report",
            source_type="news",
            relevance_note="mock data from local fixture",
        ),
        SourceReference(
            title="Creator research",
            url="https://publisher.example/research/report",
            source_type="news",
            relevance_note="source mocked by local fixture",
        ),
        SourceReference(
            title="Creator research",
            url="https://publisher.example/research/report",
            source_type="news",
            relevance_note="fixture mock",
        ),
        SourceReference(
            title="Creator research",
            url="https://publisher.example/research/report",
            source_type="news",
            relevance_note="mock fixture",
        ),
    ]
    mock_exam = [SourceReference(
        title="Assessment guide",
        url="https://publisher.example/research/report",
        source_type="news",
        relevance_note="This report discusses mock exam preparation for creators.",
    )]

    for source in note_only_mock_sources:
        assert _source_mode([source]) == "mock"

    assert _source_mode(mock_exam) == "real"


def test_degraded_mock_research_keeps_both_non_publishable_warnings():
    mock = [SourceReference(
        title="[Mock] stale fallback",
        url="https://example.com/mock",
        source_type="web",
        relevance_note="fixture mock",
    )]

    assert _source_mode(mock, degraded=True) == "degraded"
    assert _provenance_warnings(mock, degraded=True) == [
        "research_degraded_non_publishable",
        "mock_research_sources_non_publishable",
    ]


def test_sources_response_exposes_provenance_fields():
    response = SourcesResponse(
        query="brand voice",
        sources=[],
        source_mode="none",
        source_count=0,
        observed_at="2026-06-24T12:00:00+00:00",
        degraded=False,
        warnings=["research_sources_missing_review_required"],
    )

    assert response.source_mode == "none"
    assert response.source_count == 0
    assert response.observed_at == "2026-06-24T12:00:00+00:00"
    assert response.warnings == ["research_sources_missing_review_required"]
