# Content Reference Provenance Integrity

Updated: 2026-04-29

## Release Gate Summary

Verdict: PASS WITH CONDITIONS

Content Creation now has an additive backend provenance layer that can track authorized references, reject broken/stale sources before prompt construction, attach source-output lineage, and flag unsupported claims on generated outputs.

Implemented:

- `migrations/091_content_reference_provenance_integrity.sql`
- `src/services/content-reference-provenance.ts`
- Prompt-facing reference filtering in `src/services/content-reference-context.ts`
- Tests in `__tests__/services/content-reference-provenance.test.ts`

## Integrity Rules

Non-negotiable runtime rules now represented in code:

- Unauthorized tenant/user references are excluded before retrieval and prompt construction.
- Broken, stale, quarantined, deprecated, or failed-extraction references are not silently used for generation.
- Low-confidence or not-yet-indexed references are marked as review-required.
- Claims can be checked against known reference IDs.
- Outputs can store `grounded`, `partially_grounded`, or `ungrounded` provenance status.
- Source-output links are stored separately from generated text so review/debug can trace what influenced an output.

## Prompt Boundary

`buildAuthorizedContentReferenceContext(userId, tenantId)` now includes only references that passed:

- backend tenant/user scope
- source health checks
- extraction status checks
- trust-level checks
- confidence/quality thresholds

The prompt block explicitly tells the model not to invent, borrow, or mention references outside the authorized list.

## Provenance Boundary

`recordContentOutputProvenance()` persists:

- output type and ID
- references used
- claims made
- unsupported claims
- source summaries
- radar/source reuse lineage when provided
- review-required flag

This does not force every generation path to be fully grounded yet. It gives the product a reliable place to record provenance as generation and refinement paths are upgraded.

## Open Limits

- Portal/iOS source attribution rendering is not implemented in this batch.
- Existing generation paths do not yet call `recordContentOutputProvenance()` everywhere.
- Link extraction/indexing workers are not fully implemented; healthy link metadata can be recorded and respected, but extraction is still a separate workstream.
- No live external link checker was run in this backend pass.
