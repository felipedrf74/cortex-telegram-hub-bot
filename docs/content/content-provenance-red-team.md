# Content Provenance Red-Team

Updated: 2026-04-29

## Provenance Expectations

Content Creation must not invent citations, silently use unavailable sources, or present unsupported factual claims as sourced.

## Current Controls

- Reference registry tracks tenant/user scope, type, extraction status, trust level, freshness, quality, confidence, broken/stale state, source summaries, snippets, and related outputs.
- Retrieval excludes references that are broken, stale, failed/quarantined, deprecated, or below hard confidence/quality thresholds.
- Lower-confidence but still usable references are marked review-required.
- Claim grounding compares `supportedBy` IDs against authorized selected references.
- Unsupported claims trigger review warnings and block approval where workflow review is required.

## Red-Team Results

| Scenario | Result | Notes |
|---|---:|---|
| Fake citation requested | PASS | Unknown source ID is treated as unsupported. |
| Unsupported numeric claim generated | PASS | `unsupported_claims_require_review` emitted. |
| Broken link | PASS | Excluded from authorized retrieval. |
| Stale source | PASS | Excluded from authorized retrieval. |
| Failed extraction/source unavailable | PASS | Excluded from authorized retrieval. |
| Low-confidence source | PASS | Allowed only as review-required evidence. |
| Provenance through refinement | PASS | Existing regression verifies refinement preserves references. |

## Quality Gate

Generated output should be considered release-ready only when:

- Source-backed claims reference selected authorized sources.
- Ungrounded claims are labeled as unsourced or routed to review.
- Low-confidence sources have human review warnings.
- Source identifiers remain attached through refinement and repurposing.

## Open Items

- Source snippet-level claim mapping is still lightweight. Future work should add exact evidence span IDs for high-stakes factual content.
- External research connectors need the same registry and provenance rules before use in generation.
